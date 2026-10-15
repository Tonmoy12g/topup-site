/* TONMOY Topup storefront logic.
   Same-origin /api/* calls only. No secrets or credentials in this file.
   Browsing is free — login is required only at checkout.
   Auth token is stored in localStorage. */

const TOKEN_KEY = "topupbd_token";

let authToken = localStorage.getItem(TOKEN_KEY) || null;
let account = null; // {name, phone} after login
let products = [];
let activeCategory = "সব";
let buyProduct = null; // product being purchased
let moneySent = false; // has the user confirmed sending money (step 2)?
let pendingBuy = false; // true when buy was clicked before login

const $ = (id) => document.getElementById(id);

// Bangla digits for display
const BN_DIGITS = ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"];
const bn = (n) => String(n).replace(/\d/g, (d) => BN_DIGITS[d]);
const taka = (n) => "৳" + bn(n);

const ERROR_BN = {
  login_required: "অর্ডার করতে লগইন করুন।",
  invalid_phone: "সঠিক মোবাইল নম্বর দিন (01XXXXXXXXX)।",
  invalid_sender_number: "টাকা পাঠানোর সঠিক নম্বর দিন।",
  invalid_uid: "সঠিক Player ID দিন (৬-২০ অক্ষর/সংখ্যা)।",
  password_too_short: "পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে।",
  name_required: "আপনার নাম লিখুন।",
  phone_exists: "এই নম্বরে ইতিমধ্যে অ্যাকাউন্ট আছে — লগইন করুন।",
  invalid_credentials: "মোবাইল নম্বর বা পাসওয়ার্ড ভুল হয়েছে।",
  invalid_trxid: "সঠিক Transaction ID দিন (টাকা পাঠানোর পর পাওয়া কোড)।",
  invalid_payment_method: "পেমেন্ট মাধ্যম বেছে নিন।",
  money_not_sent: "আগে টাকা পাঠিয়ে 'টাকা পাঠিয়েছি' বাটন চাপুন।",
  invalid_items: "প্যাকেজ বাছাইয়ে সমস্যা — আবার চেষ্টা করুন।",
  network: "নেটওয়ার্ক সমস্যা — আবার চেষ্টা করুন।",
};

// ⭐ নিজের বিকাশ/নগদ নম্বর এখানে বসান (যে নম্বরে কাস্টমার টাকা পাঠাবে)
const SHOP_PAY_NUMBERS = { bkash: "01902461583", nagad: "01902461583", qr: "01902461583" };
function currentPayMethod() { return payMethod; }
function refreshPayUI() {
  const m = payMethod;
  $("pay-number").textContent = SHOP_PAY_NUMBERS[m] || SHOP_PAY_NUMBERS.bkash;
  $("pay-method-label").textContent = PAYMENT_BN[m] || m;
  $("add-money-img").src = PAY_IMAGES[m] || PAY_IMAGES.bkash;
  $("add-money-sub").textContent = (PAYMENT_BN[m] || m) + " দিয়ে পেমেন্ট করুন";
  const box = document.querySelector(".send-box");
  if (box) box.style.borderColor = PAY_COLORS[m] || PAY_COLORS.bkash;
  if (buyProduct) $("pay-amount").textContent = taka(buyProduct.price);
  $("pay-now-btn").textContent = "Pay " + (buyProduct ? bn(buyProduct.price) + ".00" : "0.00") + " BDT";
  document.querySelectorAll(".pay-card").forEach((c) => {
    c.classList.toggle("sel", c.dataset.m === tempPayMethod);
  });
  $("pay-method-label").textContent = PAYMENT_BN[m] || m;
  if (buyProduct) $("pay-amount").textContent = taka(buyProduct.price);
}
const PAYMENT_BN = { bkash: "বিকাশ", nagad: "নগদ", qr: "বাংলা QR" };
const PAY_IMAGES = { bkash: "bkash.png", nagad: "nagad.png", qr: "banglaqr.png" };
const PAY_COLORS = { bkash: "#e2136e", nagad: "#f6921e", qr: "#d42a1e" };
let payMethod = "bkash"; // selected payment method (via Add Money picker)
let tempPayMethod = "bkash"; // highlighted card inside the picker
const STATUS_BN = { pending: "অপেক্ষমাণ", confirmed: "কনফার্মড", delivered: "ডেলিভার্ড", cancelled: "বাতিল" };

const CATEGORIES = ["সব", "ডায়মন্ড", "মেম্বারশিপ"];

async function api(path, options = {}) {
  const headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
  if (authToken) headers["Authorization"] = "Bearer " + authToken;
  const res = await fetch(path, Object.assign({}, options, { headers }));
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON response */ }
  return { status: res.status, data };
}

/* ---------------- Auth (modal, no forced gate) ---------------- */
function openAuth(note) {
  $("auth-note").textContent = note || "";
  $("auth-error").textContent = "";
  $("auth-modal").classList.remove("hidden");
}
function closeAuth() {
  $("auth-modal").classList.add("hidden");
}

function wireAuth() {
  $("login-btn").onclick = () => openAuth("");
  $("auth-close").onclick = closeAuth;
  $("auth-modal").addEventListener("click", (e) => {
    if (e.target.id === "auth-modal") closeAuth();
  });
  const tabLogin = $("tab-login"), tabSignup = $("tab-signup");
  tabLogin.onclick = () => {
    tabLogin.classList.add("active"); tabSignup.classList.remove("active");
    $("login-form").classList.remove("hidden"); $("signup-form").classList.add("hidden");
    $("auth-error").textContent = "";
  };
  tabSignup.onclick = () => {
    tabSignup.classList.add("active"); tabLogin.classList.remove("active");
    $("signup-form").classList.remove("hidden"); $("login-form").classList.add("hidden");
    $("auth-error").textContent = "";
  };
  $("login-form").onsubmit = (e) => {
    e.preventDefault();
    doAuth("/api/auth/login", {
      phone: $("login-phone").value.trim(),
      password: $("login-password").value,
    });
  };
  $("signup-form").onsubmit = (e) => {
    e.preventDefault();
    doAuth("/api/auth/signup", {
      name: $("signup-name").value.trim(),
      phone: $("signup-phone").value.trim(),
      password: $("signup-password").value,
    });
  };
  $("logout-btn").onclick = async () => {
    try { await api("/api/auth/logout", { method: "POST" }); } catch (e) { /* ignore */ }
    authToken = null;
    account = null;
    localStorage.removeItem(TOKEN_KEY);
    renderAuthState();
  };
}

async function doAuth(path, body) {
  const errEl = $("auth-error");
  errEl.textContent = "";
  try {
    const { status, data } = await api(path, { method: "POST", body: JSON.stringify(body) });
    if ((status === 200 || status === 201) && data && data.ok) {
      authToken = data.token;
      localStorage.setItem(TOKEN_KEY, authToken);
      account = { name: data.name, phone: data.phone };
      closeAuth();
      renderAuthState();
      // Continue a purchase that was waiting for login
      if (pendingBuy && buyProduct) {
        pendingBuy = false;
        openBuy(buyProduct.id);
      }
    } else {
      errEl.textContent = ERROR_BN[(data && data.error)] || ERROR_BN.network;
    }
  } catch (e) {
    errEl.textContent = ERROR_BN.network;
  }
}

function renderAuthState() {
  const loggedIn = !!authToken;
  $("login-btn").classList.toggle("hidden", loggedIn);
  $("logout-btn").classList.toggle("hidden", !loggedIn);
  $("orders-btn").classList.toggle("hidden", !loggedIn);
  $("user-chip").classList.toggle("hidden", !loggedIn);
  if (loggedIn && account) $("user-chip").textContent = "👤 " + account.name;
}

/* ---------------- Products ---------------- */
async function loadProducts() {
  try {
    const { data } = await api("/api/products");
    products = Array.isArray(data) ? data : [];
  } catch (e) {
    products = [];
  }
  renderChips();
  renderGrid();
}

function renderChips() {
  const box = $("category-chips");
  box.innerHTML = "";
  CATEGORIES.forEach((c) => {
    const b = document.createElement("button");
    b.className = "chip" + (c === activeCategory ? " active" : "");
    b.textContent = c;
    b.onclick = () => { activeCategory = c; renderChips(); renderGrid(); };
    box.appendChild(b);
  });
}

function filteredProducts() {
  if (activeCategory === "সব") return products;
  return products.filter((p) => p.category === activeCategory);
}

function isMembership(p) {
  return p.category === "মেম্বারশিপ";
}

function cardHtml(p) {
  const amountLine = isMembership(p)
    ? `<p class="dia-amount">🎫 ${escapeHtml(p.name)}</p>`
    : `<p class="dia-amount">💎 ${bn(p.diamonds)} Diamond</p>`;
  const badge = p.badge ? `<div class="badges"><span class="badge${isMembership(p) ? " member" : ""}">${escapeHtml(p.badge)}</span></div>` : "";
  return badge +
    `<img src="${p.image}" alt="${escapeHtml(p.name)}" loading="lazy">` +
    `<div class="card-body">` + amountLine +
    `<p class="price">${taka(p.price)}</p>` +
    `<button class="btn-buy">কিনুন</button>` +
    `</div>`;
}

function renderGrid() {
  const grid = $("product-grid");
  const list = filteredProducts();
  $("no-results").classList.toggle("hidden", list.length > 0);
  grid.innerHTML = "";
  list.forEach((p) => {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = cardHtml(p);
    card.querySelector(".btn-buy").onclick = (e) => { e.stopPropagation(); startBuy(p.id); };
    grid.appendChild(card);
  });
}

/* ---------------- Buy flow (login required at checkout) ---------------- */
function startBuy(id) {
  const p = products.find((x) => x.id === id);
  if (!p) return;
  buyProduct = p;
  if (!authToken) {
    pendingBuy = true;
    openAuth("অর্ডার করতে লগইন করুন");
    return;
  }
  openBuy(id);
}

function openBuy(id) {
  const p = products.find((x) => x.id === id);
  if (!p) return;
  buyProduct = p;
  moneySent = false;
  const amountLine = isMembership(p) ? "🎫 " + p.name : "💎 " + bn(p.diamonds) + " Diamond";
  $("buy-summary").innerHTML =
    `<img src="${p.image}" alt="${escapeHtml(p.name)}">` +
    `<div><p><strong>${amountLine}</strong></p><p class="price">${taka(p.price)}</p></div>`;
  refreshPayUI();
  $("trxid-step").classList.add("hidden");
  const msBtn = $("money-sent");
  msBtn.disabled = false;
  msBtn.textContent = "✅ টাকা পাঠিয়েছি";
  msBtn.classList.remove("done");
  $("buy-error").textContent = "";
  $("buy-modal").classList.remove("hidden");
}
function closeBuy() {
  $("buy-modal").classList.add("hidden");
}

function wireBuy() {
  $("buy-close").onclick = closeBuy;
  $("buy-modal").addEventListener("click", (e) => {
    if (e.target.id === "buy-modal") closeBuy();
  });
  $("orders-btn").onclick = openOrders;
  $("orders-close").onclick = () => $("orders-modal").classList.add("hidden");
  $("orders-modal").addEventListener("click", (e) => {
    if (e.target.id === "orders-modal") $("orders-modal").classList.add("hidden");
  });
  $("buy-form").onsubmit = submitOrder;
  $("confirm-ok").onclick = () => $("confirm-modal").classList.add("hidden");
  // Add Money picker
  $("add-money-btn").onclick = () => {
    tempPayMethod = payMethod;
    refreshPayUI();
    $("pay-picker").classList.remove("hidden");
  };
  $("paypicker-close").onclick = () => $("pay-picker").classList.add("hidden");
  $("pay-picker").addEventListener("click", (e) => {
    if (e.target.id === "pay-picker") $("pay-picker").classList.add("hidden");
  });
  document.querySelectorAll(".pay-card").forEach((c) => {
    c.onclick = () => {
      tempPayMethod = c.dataset.m;
      refreshPayUI();
    };
  });
  $("pay-now-btn").onclick = () => {
    payMethod = tempPayMethod;
    refreshPayUI();
    $("pay-picker").classList.add("hidden");
  };
  $("copy-number").onclick = async () => {
    const num = $("pay-number").textContent.trim();
    const btn = $("copy-number");
    try {
      await navigator.clipboard.writeText(num);
      btn.textContent = "✅ কপি হয়েছে!";
    } catch (e) {
      // fallback: select the number text
      const range = document.createRange();
      range.selectNode($("pay-number"));
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(range);
      btn.textContent = "👆 নম্বর সিলেক্ট হয়েছে";
    }
    setTimeout(() => { btn.textContent = "📋 কপি"; }, 2000);
  };
  $("money-sent").onclick = () => {
    moneySent = true;
    $("trxid-step").classList.remove("hidden");
    const btn = $("money-sent");
    btn.disabled = true;
    btn.textContent = "✓ ধন্যবাদ! এবার নিচে TrxID দিন";
    btn.classList.add("done");
    $("trxid-step").scrollIntoView({ behavior: "smooth", block: "nearest" });
  };
}

async function submitOrder(e) {
  e.preventDefault();
  const errEl = $("buy-error");
  errEl.textContent = "";
  if (!buyProduct) { errEl.textContent = ERROR_BN.invalid_items; return; }
  if (!authToken) { closeBuy(); pendingBuy = true; openAuth("অর্ডার করতে লগইন করুন"); return; }

  const uid = $("buy-uid").value.trim();
  const senderNumber = $("buy-sender").value.trim().replace(/[\s\-]/g, "");
  const trxid = $("buy-trxid").value.trim().toUpperCase();
  const paymentMethod = payMethod;

  if (!/^[A-Za-z0-9]{6,20}$/.test(uid)) { errEl.textContent = ERROR_BN.invalid_uid; return; }
  if (!/^01[3-9]\d{8}$/.test(senderNumber)) { errEl.textContent = ERROR_BN.invalid_sender_number; return; }
  if (!["bkash", "nagad", "qr"].includes(paymentMethod)) { errEl.textContent = ERROR_BN.invalid_payment_method; return; }
  if (!moneySent) { errEl.textContent = ERROR_BN.money_not_sent; return; }
  if (!/^[A-Z0-9]{6,20}$/.test(trxid)) { errEl.textContent = ERROR_BN.invalid_trxid; return; }

  try {
    const { status, data } = await api("/api/orders", {
      method: "POST",
      body: JSON.stringify({
        uid,
        sender_number: senderNumber,
        payment_method: paymentMethod,
        trxid,
        items: [{ id: buyProduct.id, qty: 1 }],
      }),
    });
    if (status === 201 && data && data.ok) {
      closeBuy();
      $("buy-form").reset();
      $("confirm-order-id").textContent = data.order_id;
      $("confirm-total").textContent = "সর্বমোট: " + taka(data.total);
      $("confirm-modal").classList.remove("hidden");
    } else if (status === 401) {
      closeBuy();
      authToken = null;
      account = null;
      localStorage.removeItem(TOKEN_KEY);
      renderAuthState();
      pendingBuy = true;
      openAuth("অর্ডার করতে লগইন করুন");
    } else {
      errEl.textContent = ERROR_BN[(data && data.error)] || ERROR_BN.network;
    }
  } catch (e) {
    errEl.textContent = ERROR_BN.network;
  }
}

/* ---------------- My orders ---------------- */
async function openOrders() {
  const box = $("my-orders");
  box.innerHTML = '<p class="muted center">লোড হচ্ছে…</p>';
  $("orders-modal").classList.remove("hidden");
  try {
    const { status, data } = await api("/api/orders/mine");
    if (status === 401) {
      authToken = null; account = null;
      localStorage.removeItem(TOKEN_KEY);
      renderAuthState();
      closeAuthless();
      openAuth("অর্ডার দেখতে লগইন করুন");
      return;
    }
    const orders = (data && data.orders) || [];
    if (orders.length === 0) {
      box.innerHTML = '<p class="muted center">📦<br>এখনো কোনো অর্ডার নেই।</p>';
      return;
    }
    box.innerHTML = "";
    orders.forEach((o) => {
      const card = document.createElement("div");
      card.className = "order-card";
      card.innerHTML =
        `<p><span class="oid">${escapeHtml(o.order_id)}</span></p>` +
        `<p class="odate">${fmtDateBn(o.created_at)} • 🆔 ${escapeHtml(o.uid)}</p>` +
        `<p class="odate">💳 ${PAYMENT_BN[o.payment_method] || escapeHtml(o.payment_method)}</p>` +
        `<span class="ostatus ${escapeHtml(o.status)}">${STATUS_BN[o.status] || escapeHtml(o.status)}</span>` +
        `<div class="oitems">${(o.items || []).map((i) => `${escapeHtml(i.name)} × ${bn(i.qty)}`).join("<br>")}</div>` +
        `<div class="ototal"><span>সর্বমোট</span><span>${taka(o.total)}</span></div>`;
      box.appendChild(card);
    });
  } catch (e) {
    box.innerHTML = '<p class="error center">নেটওয়ার্ক সমস্যা — আবার চেষ্টা করুন।</p>';
  }
}
function closeAuthless() {
  $("orders-modal").classList.add("hidden");
}

function fmtDateBn(iso) {
  try { return new Date(iso).toLocaleString("bn-BD"); } catch (e) { return ""; }
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------------- Boot (browse freely, no gate) ---------------- */
document.addEventListener("DOMContentLoaded", async () => {
  wireAuth();
  wireBuy();
  renderAuthState();
  await loadProducts();
  // Restore session if a token is saved
  if (authToken) {
    try {
      const { status, data } = await api("/api/auth/me");
      if (status === 200 && data && data.ok) {
        account = { name: data.name, phone: data.phone };
        renderAuthState();
      } else {
        authToken = null;
        localStorage.removeItem(TOKEN_KEY);
        renderAuthState();
      }
    } catch (e) { /* stay logged out visually, token kept for retry */ }
  }
});
