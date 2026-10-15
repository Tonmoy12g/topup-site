#!/usr/bin/env python3
"""TONMOY Topup backend — Flask app serving the Free Fire diamond top-up storefront + JSON API.

Digital goods only: customer accounts with phone+password login (no forced gate —
browsing is free, login is required only at checkout). NO delivery charge, NO address,
NO COD. Payment is manual bKash/Nagad with TrxID verification (no payment API).

Run locally:
    pip install -r requirements.txt
    python app.py

Environment variables:
    ADMIN_PASSWORD   password for /admin and /api/admin/* (default: changeme123 — CHANGE IT)
    ORDERS_DB        path to the SQLite database file (default: orders.db next to app.py)
    PORT             port to listen on (default: 5000)
    TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID   optional: new-order alerts via Telegram bot
"""

import hmac
import json
import os
import re
import secrets
import sqlite3
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone

from flask import Flask, abort, g, jsonify, request, send_from_directory
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = BASE_DIR  # flat layout: index.html etc. sit next to app.py
PRODUCTS_PATH = os.path.join(FRONTEND_DIR, "products.json")
DB_PATH = os.environ.get("ORDERS_DB", os.path.join(BASE_DIR, "orders.db"))

# ---------------------------------------------------------------------------
# !!! SECURITY: change this before going live !!!
# Set ADMIN_PASSWORD in your hosting dashboard's environment variables.
# ---------------------------------------------------------------------------
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "changeme123")

BD_PHONE_RE = re.compile(r"^01[3-9]\d{8}$")
UID_RE = re.compile(r"^[A-Za-z0-9]{6,20}$")
TRXID_RE = re.compile(r"^[A-Z0-9]{6,20}$")
PAYMENT_METHODS = ("bkash", "nagad", "qr")
PAYMENT_METHOD_BN = {"bkash": "বিকাশ", "nagad": "নগদ", "qr": "বাংলা QR"}
ORDER_STATUSES = ("pending", "confirmed", "delivered", "cancelled")
MIN_PASSWORD_LEN = 6

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 5 * 1024 * 1024  # 5 MB cap for package photo uploads


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------
def get_db():
    """One SQLite connection per request (sqlite3 stdlib only)."""
    if "db" not in g:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        g.db = conn
    return g.db


@app.teardown_appcontext
def close_db(exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS users (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               name TEXT NOT NULL,
               phone TEXT NOT NULL UNIQUE,
               password_hash TEXT NOT NULL,
               created_at TEXT NOT NULL
           )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS sessions (
               token TEXT PRIMARY KEY,
               user_id INTEGER NOT NULL REFERENCES users(id),
               created_at TEXT NOT NULL
           )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS orders (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               order_id TEXT NOT NULL UNIQUE,
               user_id INTEGER REFERENCES users(id),
               uid TEXT NOT NULL,
               phone TEXT NOT NULL,
               sender_number TEXT NOT NULL,
               items TEXT NOT NULL,
               total INTEGER NOT NULL,
               payment_method TEXT NOT NULL,
               trxid TEXT NOT NULL,
               status TEXT NOT NULL DEFAULT 'pending',
               created_at TEXT NOT NULL
           )"""
    )
    # Migration: add trxid column if an older orders table lacks it.
    cols = {r[1] for r in conn.execute("PRAGMA table_info(orders)").fetchall()}
    if "trxid" not in cols:
        conn.execute("ALTER TABLE orders ADD COLUMN trxid TEXT")
    # Wallet: balance column on users.
    ucols = {r[1] for r in conn.execute("PRAGMA table_info(users)").fetchall()}
    if "balance" not in ucols:
        conn.execute("ALTER TABLE users ADD COLUMN balance INTEGER NOT NULL DEFAULT 0")
    # Wallet: balance top-up requests.
    conn.execute(
        """CREATE TABLE IF NOT EXISTS topups (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               topup_id TEXT NOT NULL UNIQUE,
               user_id INTEGER NOT NULL REFERENCES users(id),
               amount INTEGER NOT NULL,
               payment_method TEXT NOT NULL,
               sender_number TEXT NOT NULL,
               trxid TEXT NOT NULL,
               status TEXT NOT NULL DEFAULT 'pending',
               created_at TEXT NOT NULL
           )"""
    )
    conn.commit()
    conn.close()


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def normalize_phone(raw):
    return re.sub(r"[\s\-]", "", str(raw or ""))


def err(code, status):
    return jsonify({"ok": False, "error": code}), status


def load_products():
    with open(PRODUCTS_PATH, encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# Auth helpers (same as the GlowMart base — phone+password, Bearer sessions)
# ---------------------------------------------------------------------------
def _bearer_token():
    auth = request.headers.get("Authorization", "")
    if auth[:7].lower() == "bearer ":
        return auth[7:].strip()
    q = request.args.get("token")
    return q.strip() if q else None


def current_user():
    """Return the logged-in user dict or None."""
    token = _bearer_token()
    if not token:
        return None
    conn = get_db()
    row = conn.execute(
        """SELECT u.id, u.name, u.phone, u.balance FROM sessions s
           JOIN users u ON u.id = s.user_id WHERE s.token = ?""",
        (token,),
    ).fetchone()
    return dict(row) if row else None


def require_user():
    user = current_user()
    if not user:
        return None, err("login_required", 401)
    return user, None


def create_session(conn, user_id):
    token = secrets.token_urlsafe(32)
    conn.execute(
        "INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)",
        (token, user_id, now_iso()),
    )
    return token


# ---------------------------------------------------------------------------
# Auth API
# ---------------------------------------------------------------------------
@app.post("/api/auth/signup")
def signup():
    data = request.get_json(force=True, silent=True) or {}
    name = str(data.get("name") or "").strip()
    phone = normalize_phone(data.get("phone"))
    password = str(data.get("password") or "")

    if not name:
        return err("name_required", 400)
    if not BD_PHONE_RE.match(phone):
        return err("invalid_phone", 400)
    if len(password) < MIN_PASSWORD_LEN:
        return err("password_too_short", 400)

    conn = get_db()
    if conn.execute("SELECT 1 FROM users WHERE phone = ?", (phone,)).fetchone():
        return err("phone_exists", 409)

    # NEVER store plaintext passwords: salted PBKDF2 hash via werkzeug.
    pw_hash = generate_password_hash(password)
    cur = conn.execute(
        "INSERT INTO users (name, phone, password_hash, created_at) VALUES (?,?,?,?)",
        (name, phone, pw_hash, now_iso()),
    )
    token = create_session(conn, cur.lastrowid)
    conn.commit()
    return jsonify({"ok": True, "token": token, "name": name, "phone": phone, "balance": 0}), 201


@app.post("/api/auth/login")
def login():
    data = request.get_json(force=True, silent=True) or {}
    phone = normalize_phone(data.get("phone"))
    password = str(data.get("password") or "")

    conn = get_db()
    row = conn.execute("SELECT * FROM users WHERE phone = ?", (phone,)).fetchone()
    if not row or not check_password_hash(row["password_hash"], password):
        return err("invalid_credentials", 401)

    token = create_session(conn, row["id"])
    conn.commit()
    bal = row["balance"] if "balance" in row.keys() and row["balance"] is not None else 0
    return jsonify({"ok": True, "token": token, "name": row["name"], "phone": row["phone"], "balance": int(bal)})


@app.get("/api/auth/me")
def me():
    user = current_user()
    if not user:
        return err("login_required", 401)
    bal = user["balance"] if "balance" in user.keys() and user["balance"] is not None else 0
    return jsonify({"ok": True, "name": user["name"], "phone": user["phone"], "balance": int(bal)})


@app.post("/api/auth/logout")
def logout():
    token = _bearer_token()
    if token:
        conn = get_db()
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
        conn.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Telegram owner alert (optional, exception-safe)
# ---------------------------------------------------------------------------
def send_telegram_order_alert(order):
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    if not token or not chat_id:
        return
    try:
        lines = [
            "🎮 *নতুন টপ-আপ অর্ডার!*",
            "🧾 `%s`" % order["order_id"],
            "🆔 UID: `%s`" % order["uid"],
            "👤 নাম: %s" % order["name"],
            "📞 ফোন: %s" % order["phone"],
            "📦 প্যাকেজ:",
        ]
        for it in order["items"]:
            lines.append("  • %s × %d = ৳%d" % (it["name"], it["qty"], it["price"] * it["qty"]))
        pm = PAYMENT_METHOD_BN.get(order["payment_method"], order["payment_method"])
        lines.append("💳 পেমেন্ট: %s" % pm)
        lines.append("🔑 TrxID: `%s`" % order["trxid"])
        lines.append("💰 মোট: *৳%d*" % order["total"])
        payload = urllib.parse.urlencode(
            {"chat_id": chat_id, "text": "\n".join(lines), "parse_mode": "Markdown"}
        ).encode()
        req = urllib.request.Request(
            "https://api.telegram.org/bot%s/sendMessage" % token,
            data=payload,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        urllib.request.urlopen(req, timeout=8).read()
    except Exception:
        pass  # alerts must never break order placement


def send_telegram_topup_alert(t):
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    if not token or not chat_id:
        return
    try:
        pm = PAYMENT_METHOD_BN.get(t["payment_method"], t["payment_method"])
        lines = [
            "💰 *নতুন ব্যালেন্স রিকোয়েস্ট!*",
            "🧾 `%s`" % t["topup_id"],
            "👤 নাম: %s" % t["name"],
            "📞 ফোন: %s" % t["phone"],
            "💵 পরিমাণ: *৳%d*" % t["amount"],
            "💳 মাধ্যম: %s" % pm,
            "🔑 TrxID: `%s`" % t["trxid"],
        ]
        payload = urllib.parse.urlencode(
            {"chat_id": chat_id, "text": "\n".join(lines), "parse_mode": "Markdown"}
        ).encode()
        req = urllib.request.Request(
            "https://api.telegram.org/bot%s/sendMessage" % token,
            data=payload,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        urllib.request.urlopen(req, timeout=8).read()
    except Exception:
        pass  # alerts must never break top-up submission


# ---------------------------------------------------------------------------
# Storefront API
# ---------------------------------------------------------------------------
@app.get("/api/products")
def api_products():
    return jsonify(load_products())


def new_order_id(conn):
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    for _ in range(20):
        oid = "TU-" + "".join(secrets.choice(alphabet) for _ in range(6))
        if not conn.execute("SELECT 1 FROM orders WHERE order_id = ?", (oid,)).fetchone():
            return oid
    raise RuntimeError("could not generate a unique order id")


def order_dict(row):
    """Normalize an orders row (tolerates rows missing newer columns)."""
    o = dict(row)
    try:
        o["items"] = json.loads(o["items"])
    except (TypeError, ValueError):
        o["items"] = []
    if o.get("trxid") is None:
        o["trxid"] = ""
    return o


@app.post("/api/orders")
def create_order():
    # Orders require a logged-in account; payment comes from wallet balance.
    # The customer only provides their game UID — no per-order payment.
    user, error = require_user()
    if error:
        return error

    data = request.get_json(force=True, silent=True) or {}
    uid = str(data.get("uid") or "").strip()
    items_in = data.get("items") or []

    if not UID_RE.match(uid):
        return err("invalid_uid", 400)

    products = {p["id"]: p for p in load_products()}
    items, total = [], 0
    for it in items_in:
        pid = it.get("id")
        qty = it.get("qty")
        # Top-up orders are one package per line; qty must be exactly 1.
        if pid not in products or qty != 1:
            return err("invalid_items", 400)
        price = int(products[pid]["price"])
        items.append(
            {
                "id": pid,
                "name": products[pid]["name"],
                "diamonds": int(products[pid].get("diamonds", 0)),
                "price": price,
                "qty": 1,
            }
        )
        total += price
    if not items:
        return err("empty_cart", 400)

    # Server-computed total: client totals are never trusted.
    # Wallet: deduct from balance atomically; reject if insufficient.
    conn = get_db()
    row = conn.execute("SELECT balance FROM users WHERE id = ?", (user["id"],)).fetchone()
    balance = int(row["balance"] or 0) if row else 0
    if balance < total:
        return err("insufficient_balance", 402)
    conn.execute("UPDATE users SET balance = balance - ? WHERE id = ?", (total, user["id"]))
    order_id = new_order_id(conn)
    conn.execute(
        """INSERT INTO orders
           (order_id, user_id, uid, phone, sender_number, items, total,
            payment_method, trxid, status, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            order_id,
            user["id"],
            uid,
            user["phone"],
            "",
            json.dumps(items, ensure_ascii=False),
            total,
            "wallet",
            "",
            "pending",
            now_iso(),
        ),
    )
    conn.commit()
    order = {
        "order_id": order_id,
        "uid": uid,
        "name": user["name"],
        "phone": user["phone"],
        "items": items,
        "total": total,
        "payment_method": "wallet",
        "trxid": "",
    }
    send_telegram_order_alert(order)
    return jsonify({"ok": True, "order_id": order_id, "total": total, "balance": balance - total}), 201


@app.get("/api/orders/mine")
def my_orders():
    """The logged-in customer's own orders, newest first."""
    user, error = require_user()
    if error:
        return error
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC", (user["id"],)
    ).fetchall()
    return jsonify({"ok": True, "orders": [order_dict(r) for r in rows]})


# ---------------------------------------------------------------------------
# Wallet top-ups (Add Money): customer sends money manually, admin approves
# ---------------------------------------------------------------------------
def new_topup_id(conn):
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    for _ in range(20):
        tid = "TP-" + "".join(secrets.choice(alphabet) for _ in range(6))
        if not conn.execute("SELECT 1 FROM topups WHERE topup_id = ?", (tid,)).fetchone():
            return tid
    raise RuntimeError("topup id collision")


@app.post("/api/topup")
def create_topup():
    """Submit a balance top-up request (manual bKash/Nagad/Bangla QR)."""
    user, error = require_user()
    if error:
        return error
    data = request.get_json(force=True, silent=True) or {}
    try:
        amount = int(data.get("amount") or 0)
    except (TypeError, ValueError):
        return err("invalid_amount", 400)
    payment_method = str(data.get("payment_method") or "").strip().lower()
    sender_number = normalize_phone(data.get("sender_number"))
    trxid = str(data.get("trxid") or "").strip().upper()

    if amount < 10 or amount > 100000:
        return err("invalid_amount", 400)
    if payment_method not in PAYMENT_METHODS:
        return err("invalid_payment_method", 400)
    if not BD_PHONE_RE.match(sender_number):
        return err("invalid_sender_number", 400)
    if not TRXID_RE.match(trxid):
        return err("invalid_trxid", 400)

    conn = get_db()
    if conn.execute("SELECT 1 FROM topups WHERE trxid = ?", (trxid,)).fetchone():
        return err("duplicate_trxid", 409)
    topup_id = new_topup_id(conn)
    conn.execute(
        """INSERT INTO topups
           (topup_id, user_id, amount, payment_method, sender_number, trxid, status, created_at)
           VALUES (?,?,?,?,?,?,?,?)""",
        (topup_id, user["id"], amount, payment_method, sender_number, trxid, "pending", now_iso()),
    )
    conn.commit()
    send_telegram_topup_alert(
        {"topup_id": topup_id, "name": user["name"], "phone": user["phone"],
         "amount": amount, "payment_method": payment_method, "trxid": trxid}
    )
    return jsonify({"ok": True, "topup_id": topup_id}), 201


@app.get("/api/topup/mine")
def my_topups():
    """The logged-in customer's own top-up requests, newest first."""
    user, error = require_user()
    if error:
        return error
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM topups WHERE user_id = ? ORDER BY id DESC", (user["id"],)
    ).fetchall()
    return jsonify({"ok": True, "topups": [dict(r) for r in rows]})


# ---------------------------------------------------------------------------
# Admin (password-protected)
# ---------------------------------------------------------------------------
def admin_authorized():
    pw = request.args.get("password", "")
    if not pw and request.is_json:
        pw = (request.get_json(silent=True) or {}).get("password", "")
    return hmac.compare_digest(str(pw), ADMIN_PASSWORD)


@app.get("/api/admin/orders")
def admin_orders():
    if not admin_authorized():
        return err("unauthorized", 401)
    conn = get_db()
    rows = conn.execute("SELECT * FROM orders ORDER BY id DESC").fetchall()
    return jsonify({"ok": True, "orders": [order_dict(r) for r in rows]})


@app.get("/admin")
def admin_page():
    return send_from_directory(BASE_DIR, "admin.html")


# ---------------------------------------------------------------------------
# Admin: dashboard stats, buyers, order status, package management
# ---------------------------------------------------------------------------
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
ALLOWED_PHOTO_EXT = {"jpg", "jpeg", "png", "webp"}


@app.get("/api/admin/stats")
def admin_stats():
    if not admin_authorized():
        return err("unauthorized", 401)
    conn = get_db()
    total_orders = conn.execute("SELECT COUNT(*) FROM orders").fetchone()[0]
    total_revenue = conn.execute("SELECT COALESCE(SUM(total),0) FROM orders").fetchone()[0]
    total_buyers = conn.execute("SELECT COUNT(DISTINCT phone) FROM orders").fetchone()[0]
    pending_topups = conn.execute("SELECT COUNT(*) FROM topups WHERE status = 'pending'").fetchone()[0]
    return jsonify({
        "ok": True,
        "total_orders": total_orders,
        "total_revenue": total_revenue,
        "total_buyers": total_buyers,
        "total_products": len(load_products()),
        "pending_topups": pending_topups,
    })


@app.get("/api/admin/buyers")
def admin_buyers():
    if not admin_authorized():
        return err("unauthorized", 401)
    conn = get_db()
    rows = conn.execute(
        """SELECT phone, COUNT(*) AS order_count, SUM(total) AS total_spent,
                  MAX(created_at) AS last_order
           FROM orders GROUP BY phone ORDER BY last_order DESC"""
    ).fetchall()
    return jsonify({"ok": True, "buyers": [dict(r) for r in rows]})


@app.post("/api/admin/orders/<order_id>/status")
def admin_order_status(order_id):
    if not admin_authorized():
        return err("unauthorized", 401)
    data = request.get_json(force=True, silent=True) or {}
    status = str(data.get("status") or "").strip().lower()
    if status not in ORDER_STATUSES:
        return err("invalid_status", 400)
    conn = get_db()
    cur = conn.execute(
        "UPDATE orders SET status = ? WHERE order_id = ?", (status, order_id)
    )
    conn.commit()
    if cur.rowcount == 0:
        return err("order_not_found", 404)
    return jsonify({"ok": True})


@app.get("/api/admin/topups")
def admin_topups():
    if not admin_authorized():
        return err("unauthorized", 401)
    status = request.args.get("status", "").strip().lower()
    conn = get_db()
    q = """SELECT t.*, u.name AS user_name, u.phone AS user_phone
           FROM topups t JOIN users u ON u.id = t.user_id"""
    params = []
    if status in ("pending", "approved", "rejected"):
        q += " WHERE t.status = ?"
        params.append(status)
    q += " ORDER BY t.id DESC"
    rows = conn.execute(q, params).fetchall()
    return jsonify({"ok": True, "topups": [dict(r) for r in rows]})


@app.post("/api/admin/topups/<int:tid>/approve")
def admin_topup_approve(tid):
    if not admin_authorized():
        return err("unauthorized", 401)
    conn = get_db()
    row = conn.execute("SELECT * FROM topups WHERE id = ?", (tid,)).fetchone()
    if not row:
        return err("topup_not_found", 404)
    if row["status"] != "pending":
        return err("already_processed", 409)
    conn.execute("UPDATE topups SET status = 'approved' WHERE id = ?", (tid,))
    conn.execute(
        "UPDATE users SET balance = balance + ? WHERE id = ?",
        (int(row["amount"]), int(row["user_id"])),
    )
    conn.commit()
    bal = conn.execute("SELECT balance FROM users WHERE id = ?", (int(row["user_id"]),)).fetchone()
    return jsonify({"ok": True, "balance": int(bal["balance"] or 0)})


@app.post("/api/admin/topups/<int:tid>/reject")
def admin_topup_reject(tid):
    if not admin_authorized():
        return err("unauthorized", 401)
    conn = get_db()
    row = conn.execute("SELECT * FROM topups WHERE id = ?", (tid,)).fetchone()
    if not row:
        return err("topup_not_found", 404)
    if row["status"] != "pending":
        return err("already_processed", 409)
    conn.execute("UPDATE topups SET status = 'rejected' WHERE id = ?", (tid,))
    conn.commit()
    return jsonify({"ok": True})


def save_products(products):
    """Atomic write so a crash never leaves a half-written catalog."""
    tmp = PRODUCTS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(products, f, ensure_ascii=False, indent=2)
    os.replace(tmp, PRODUCTS_PATH)


def make_product_id(name, existing_ids):
    slug = re.sub(r"[^a-z0-9]+", "-", str(name or "").lower()).strip("-")[:40] or "package"
    for _ in range(10):
        pid = "%s-%s" % (slug, secrets.token_hex(3))
        if pid not in existing_ids:
            return pid
    raise RuntimeError("could not generate a unique product id")


def validate_product_payload(data, partial=False):
    """Validate admin package input. Returns (cleaned_dict, error_code)."""
    required = ["name", "diamonds", "category", "price", "image", "description"]
    cleaned = {}
    if not partial:
        for field in required:
            if data.get(field) in (None, ""):
                return None, "missing_" + field
    if data.get("diamonds") is not None:
        try:
            diamonds = int(data.get("diamonds"))
        except (TypeError, ValueError):
            return None, "invalid_diamonds"
        if diamonds < 0:
            return None, "invalid_diamonds"
        cleaned["diamonds"] = diamonds
    if data.get("price") is not None:
        try:
            price = float(data.get("price"))
        except (TypeError, ValueError):
            return None, "invalid_price"
        if price <= 0:
            return None, "invalid_price"
        cleaned["price"] = int(price) if price.is_integer() else price
    for field in ["name", "category", "image", "description", "badge"]:
        if data.get(field) not in (None, ""):
            cleaned[field] = str(data.get(field)).strip()
    return cleaned, None


@app.get("/api/admin/products")
def admin_product_list():
    if not admin_authorized():
        return err("unauthorized", 401)
    return jsonify({"ok": True, "products": load_products()})


@app.post("/api/admin/products")
def admin_product_create():
    if not admin_authorized():
        return err("unauthorized", 401)
    data = request.get_json(force=True, silent=True) or {}
    cleaned, error = validate_product_payload(data)
    if error:
        return err(error, 400)
    products = load_products()
    pid = make_product_id(cleaned["name"], {p["id"] for p in products})
    product = {"id": pid}
    product.update(cleaned)
    products.append(product)
    save_products(products)
    return jsonify({"ok": True, "product": product}), 201


@app.put("/api/admin/products/<pid>")
def admin_product_update(pid):
    if not admin_authorized():
        return err("unauthorized", 401)
    data = request.get_json(force=True, silent=True) or {}
    cleaned, error = validate_product_payload(data, partial=True)
    if error:
        return err(error, 400)
    products = load_products()
    for p in products:
        if p["id"] == pid:
            p.update(cleaned)
            save_products(products)
            return jsonify({"ok": True, "product": p})
    return err("product_not_found", 404)


@app.delete("/api/admin/products/<pid>")
def admin_product_delete(pid):
    if not admin_authorized():
        return err("unauthorized", 401)
    products = load_products()
    removed = [p for p in products if p["id"] == pid]
    if not removed:
        return err("product_not_found", 404)
    img = str(removed[0].get("image") or "")
    if img.startswith("uploads/"):
        # Only delete files inside our uploads dir (no path traversal).
        target = os.path.abspath(os.path.join(BASE_DIR, img))
        if target.startswith(os.path.abspath(UPLOAD_DIR) + os.sep) and os.path.isfile(target):
            os.remove(target)
    save_products([p for p in products if p["id"] != pid])
    return jsonify({"ok": True})


@app.post("/api/admin/products/upload")
def admin_product_upload():
    if not admin_authorized():
        return err("unauthorized", 401)
    file = request.files.get("photo")
    if not file or not file.filename:
        return err("no_photo", 400)
    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else ""
    if ext not in ALLOWED_PHOTO_EXT:
        return err("bad_extension", 400)
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    safe = secure_filename(file.filename) or ("photo." + ext)
    fname = "%s-%s" % (uuid.uuid4().hex[:12], safe)
    file.save(os.path.join(UPLOAD_DIR, fname))
    return jsonify({"ok": True, "image": "uploads/" + fname}), 201


# ---------------------------------------------------------------------------
# Static frontend
# ---------------------------------------------------------------------------
@app.get("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.get("/<path:filename>")
def frontend_files(filename):
    # Never expose backend code, the database, or dotfiles.
    if filename.startswith("backend/") or filename.startswith(".") or "/." in "/" + filename:
        abort(404)
    return send_from_directory(FRONTEND_DIR, filename)


# init_db() must run at import time: gunicorn imports this module
# (so __main__ never runs there) and the DB tables must exist.
init_db()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
