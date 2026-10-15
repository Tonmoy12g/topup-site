/* TONMOY Topup storefront logic.
   Same-origin /api/* calls only. No secrets or credentials in this file.
   Browsing is free — login is required only at checkout.
   Auth token is stored in localStorage. */

const TOKEN_KEY = "topupbd_token";

let authToken = localStorage.getItem(TOKEN_KEY) || null;
let account = null; // {name, phone, balance} after login
let products = [];
let activeCategory = "সব";
let buyProduct = null; // product being purchased
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
  invalid_items: "প্যাকেজ বাছাইয়ে সমস্যা — আবার চেষ্টা করুন।",
  insufficient_balance: "ব্যালেন্স কম আছে — উপরে Add Money করে ব্যালেন্স যোগ করুন।",
  invalid_amount: "সঠিক টাকার পরিমাণ দিন (৳১০ – ৳১,০০,০০০)।",
  network: "নেটওয়ার্ক সমস্যা — আবার চেষ্টা করুন।",
};

// ⭐ নিজের বিকাশ/নগদ নম্বর এখানে বসান (যে নম্বরে কাস্টমার টাকা পাঠাবে)
const SHOP_PAY_NUMBERS = { bkash: "01902461583", nagad: "01902461583", qr: "01902461583" };
function currentPayMethod() { return payMethod; }
function refreshPayUI() {
  const m = payMethod;
  const num = SHOP_PAY_NUMBERS[m] || SHOP_PAY_NUMBERS.bkash;
  const name = PAYMENT_BN[m] || m;
  const hpNum = $("hp-pay-number");
  if (hpNum) hpNum.textContent = num;
  const hpMethod = $("hp-pay-method");
  if (hpMethod) hpMethod.textContent = name;
  const nbBox = $("pay-number-box");
  if (nbBox) nbBox.style.borderColor = PAY_COLORS[m] || PAY_COLORS.bkash;
  document.querySelectorAll(".pay-card").forEach((c) => {
    c.classList.toggle("sel", c.dataset.m === m);
  });
}
const PAYMENT_BN = { bkash: "বিকাশ", nagad: "নগদ", qr: "বাংলা QR" };
const PAY_COLORS = { bkash: "#e2136e", nagad: "#f6921e", qr: "#d42a1e" };
let payMethod = "bkash"; // selected payment method (via homepage buttons)
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
      account = { name: data.name, phone: data.phone, balance: data.balance || 0 };
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
  $("balance-chip").classList.toggle("hidden", !loggedIn);
  if (loggedIn && account) {
    $("user-chip").textContent = "👤 " + account.name;
    $("balance-chip").textContent = "💰 " + taka(account.balance || 0);
  }
}
function setBalance(b) {
  if (account) { account.balance = b; }
  renderAuthState();
  const bp = $("buy-balance");
  if (bp) bp.textContent = taka(b);
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
  const amountLine = isMembership(p) ? "🎫 " + p.name : "💎 " + bn(p.diamonds) + " Diamond";
  $("buy-summary").innerHTML =
    `<img src="${p.image}" alt="${escapeHtml(p.name)}">` +
    `<div><p><strong>${amountLine}</strong></p><p class="price">${taka(p.price)}</p></div>`;
  refreshPayUI();
  $("buy-price").textContent = taka(p.price);
  $("buy-balance").textContent = taka(account ? account.balance || 0 : 0);
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
  // Add Money: toggle options, select method, copy number
  $("addmoney-toggle").onclick = () => {
    $("pay-options").classList.toggle("hidden");
  };
  document.querySelectorAll(".home-pay .pay-card").forEach((c) => {
    c.onclick = () => {
      payMethod = c.dataset.m;
      $("pay-number-box").classList.remove("hidden");
      refreshPayUI();
    };
  });
  $("hp-copy").onclick = async () => {
    const num = $("hp-pay-number").textContent.trim();
    const btn = $("hp-copy");
    try {
      await navigator.clipboard.writeText(num);
      btn.textContent = "✅ কপি হয়েছে!";
    } catch (e) {
      btn.textContent = "👆 নম্বরটি সিলেক্ট করুন";
    }
    setTimeout(() => { btn.textContent = "📋 কপি"; }, 2000);
  };
  // Balance top-up request
  $("tp-submit").onclick = submitTopup;
  $("tp-history-link").onclick = (e) => { e.preventDefault(); toggleTopupHistory(); };
}

const TOPUP_STATUS_BN = { pending: "অপেক্ষমাণ", approved: "✅ অনুমোদিত", rejected: "❌ বাতিল" };

async function submitTopup() {
  const errEl = $("tp-error");
  errEl.textContent = "";
  if (!authToken) { openAuth("ব্যালেন্স যোগ করতে লগইন করুন"); return; }
  const amount = parseInt($("tp-amount").value, 10);
  const sender = $("tp-sender").value.trim().replace(/[\s\-]/g, "");
  const trxid = $("tp-trxid").value.trim().toUpperCase();
  if (!(amount >= 10 && amount <= 100000)) { errEl.textContent = ERROR_BN.invalid_amount; return; }
  if (!/^01[3-9]\d{8}$/.test(sender)) { errEl.textContent = ERROR_BN.invalid_sender_number; return; }
  if (!/^[A-Z0-9]{6,20}$/.test(trxid)) { errEl.textContent = ERROR_BN.invalid_trxid; return; }
  try {
    const { status, data } = await api("/api/topup", {
      method: "POST",
      body: JSON.stringify({ amount, payment_method: payMethod, sender_number: sender, trxid }),
    });
    if (status === 201 && data && data.ok) {
      $("tp-amount").value = ""; $("tp-sender").value = ""; $("tp-trxid").value = "";
      errEl.textContent = "";
      alert("✅ রিকোয়েস্ট পাঠানো হয়েছে! অ্যাডমিন ভেরিফাই করলে ব্যালেন্স যোগ হবে। (ID: " + data.topup_id + ")");
    } else if (status === 401) {
      openAuth("ব্যালেন্স যোগ করতে লগইন করুন");
    } else {
      errEl.textContent = ERROR_BN[(data && data.error)] || ERROR_BN.network;
    }
  } catch (e) {
    errEl.textContent = ERROR_BN.network;
  }
}

async function toggleTopupHistory() {
  const box = $("tp-history");
  if (!box.classList.contains("hidden")) { box.classList.add("hidden"); return; }
  if (!authToken) { openAuth("লগইন করুন"); return; }
  box.innerHTML = '<p class="muted center">লোড হচ্ছে…</p>';
  box.classList.remove("hidden");
  try {
    const { status, data } = await api("/api/topup/mine");
    if (status === 200 && data && data.ok) {
      if (!data.topups.length) { box.innerHTML = '<p class="muted center">কোনো রিকোয়েস্ট নেই।</p>'; return; }
      box.innerHTML = data.topups.map((t) =>
        `<div class="tp-row"><span>🧾 ${escapeHtml(t.topup_id)}</span>` +
        `<span>৳${bn(t.amount)}</span>` +
        `<span>${TOPUP_STATUS_BN[t.status] || escapeHtml(t.status)}</span></div>`
      ).join("");
    }
  } catch (e) {
    box.innerHTML = '<p class="muted center">লোড করা যায়নি।</p>';
  }
}

async function submitOrder(e) {
  e.preventDefault();
  const errEl = $("buy-error");
  errEl.textContent = "";
  if (!buyProduct) { errEl.textContent = ERROR_BN.invalid_items; return; }
  if (!authToken) { closeBuy(); pendingBuy = true; openAuth("অর্ডার করতে লগইন করুন"); return; }

  const uid = $("buy-uid").value.trim();

  if (!/^[A-Za-z0-9]{6,20}$/.test(uid)) { errEl.textContent = ERROR_BN.invalid_uid; return; }
  // Wallet: price is deducted from balance server-side.
  const bal = account ? account.balance || 0 : 0;
  if (bal < buyProduct.price) { errEl.textContent = ERROR_BN.insufficient_balance; return; }

  try {
    const { status, data } = await api("/api/orders", {
      method: "POST",
      body: JSON.stringify({
        uid,
        items: [{ id: buyProduct.id, qty: 1 }],
      }),
    });
    if (status === 201 && data && data.ok) {
      closeBuy();
      $("buy-form").reset();
      setBalance(data.balance);
      $("confirm-order-id").textContent = data.order_id;
      $("confirm-total").textContent = "সর্বমোট: " + taka(data.total);
      $("confirm-modal").classList.remove("hidden");
    } else if (status === 402) {
      errEl.textContent = ERROR_BN.insufficient_balance;
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
  refreshPayUI();
  renderAuthState();
  await loadProducts();
  // Restore session if a token is saved
  if (authToken) {
    try {
      const { status, data } = await api("/api/auth/me");
      if (status === 200 && data && data.ok) {
        account = { name: data.name, phone: data.phone, balance: data.balance || 0 };
        renderAuthState();
      } else {
        authToken = null;
        localStorage.removeItem(TOKEN_KEY);
        renderAuthState();
      }
    } catch (e) { /* stay logged out visually, token kept for retry */ }
  }
});
