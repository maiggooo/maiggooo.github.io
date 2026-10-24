// Shared by all pages: theme toggle, ads toggle and side ads.
// Load with <script src="site.js"></script> before the page's own script.
// A page can redefine setTheme(theme, manual) to add its own behaviour (see werwolf.html).

function initTheme() {
  const saved = localStorage.getItem("ms-theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  setTheme(saved || (prefersDark ? "dark" : "light"));
}
function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("ms-theme", theme);
  const label = document.getElementById("themeLabel");
  if (label) label.textContent = theme === "dark" ? "Light" : "Dark";
}
document.getElementById("themeToggle")?.addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme");
  const next = cur === "dark" ? "light" : "dark";
  const swap = () => setTheme(next, true);
  if (document.startViewTransition && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.startViewTransition(swap);
  } else {
    swap();
  }
});

function setAds(on) {
  document.body.classList.toggle("ads-off", !on);
  localStorage.setItem("ms-ads", on ? "on" : "off");
  const label = document.getElementById("adsLabel"); if (label) label.textContent = on ? "Ads" : "Ads·off";
  const dot = document.getElementById("adsDot"); if (dot) dot.style.background = on ? "var(--ink)" : "transparent";
}
document.getElementById("adsToggle")?.addEventListener("click", () => {
  const on = !document.body.classList.contains("ads-off");
  setAds(!on);
});

const PAYPAL_AD = {
  cls:"paypal", eyebrow:"UNTERSTÜTZUNG", hero:"☕",
  title:"Ein Kaffee für Maiko?",
  body:"Wenn dir die App hilft — kleine Geste, große Freude.",
  cta:{ label:"paypal.me/maiggooo →", url:"https://paypal.me/maiggooo" },
  foot:"PAYPAL · DANKE", mark:"♡"
};
const ADS = [
  { cls:"kaffee",  eyebrow:"CAMPUS",            hero:"· · ·",                title:"Linas Kaffee",              body:"Der einzige Grund, morgens die Vorlesung nicht zu schwänzen. Bohnen aus Überzeugung.", foot:"Mo–Fr · ab 07:30",     mark:"L" },
  { cls:"stink",   eyebrow:"DIENSTLEISTUNG",    hero:"☁ ☁ ☁",                title:"Pauls Stinke­service", body:"„Wir liefern Duft. Meistens den falschen.“",                                           foot:"Auf Anfrage",          mark:"P" },
  { cls:"pfalz",   eyebrow:"SEIT '74",          hero:"MARKT · FASS · FLASCHE", title:"Getränke Pfalzgraf",     body:"Regional, ehrlich, kalt. Für jede Runde die richtige Kiste.",                          foot:"Landau · Pfalz",       mark:"✦", link:"http://www.getraenke-pfalzgraf.de/" },
  { cls:"kirche",  eyebrow:"SONNTAGS · 10 UHR",  hero:"✝",                   title:"Kians Gottesdienst",        body:"Predigt, Musik, Kaffee danach. Kommt zahlreich.",                                      foot:"Eintritt frei",        mark:"K" },
  { cls:"reise",   eyebrow:"REISEBÜRO",          hero:"✈",                   title:"Konsis Reiseplaner",        body:"Von Biebergemünd in die Welt — und rechtzeitig zurück zur Klausur.",                   foot:"Buchung · 24/7",       mark:"→" },
  { cls:"schweig", eyebrow:"PREMIUM STILLE",     hero:". . .",               title:"Katalinas Schweigen.",      body:"Der Schweigeservice. Wir sagen nichts. Garantiert.",                                   foot:"Diskretion inklusive", mark:"—" },
  { cls:"gastro",  eyebrow:"CATERING",           hero:"G · I · G",           title:"Mats Gastro",               body:"Für Events, Meetings und den echten Hunger nach der Vorlesung.",                       foot:"Anfrage per DM",       mark:"M" },
  { cls:"minion",  eyebrow:"LIVE-PERFORMANCE",   hero:"BELLO!",              title:"Selinas Minion Impressionen", body:"Banana. Papoy. Tulaliloo. Selina macht sie alle — auf Wunsch mit Latzhose.",         foot:"Buchbar für Events",   mark:"S" }
];

function renderAd(slotEl, ad) {
  const ctaHTML = ad.cta ? `<a class="ad-cta" href="${ad.cta.url}" target="_blank" rel="noopener">${ad.cta.label}</a>` : ``;
  const inner = `
    <div class="ad ad--${ad.cls}">
      <div class="ad-eyebrow"><span class="sep">·</span><span>${ad.eyebrow}</span></div>
      ${ad.hero ? `<div class="ad-hero">${ad.hero}</div>` : ``}
      <div class="ad-title">${ad.title}</div>
      <div class="ad-body">${ad.body}</div>
      ${ctaHTML}
      <div class="ad-foot"><span>${ad.foot}</span><span class="ad-mark">${ad.mark}</span></div>
    </div>`;
  slotEl.innerHTML = ad.link
    ? `<a class="ad-link" href="${ad.link}" target="_blank" rel="noopener">${inner}</a>`
    : inner;
  requestAnimationFrame(() => {
    const el = slotEl.querySelector('.ad');
    if (el) el.classList.add('show');
  });
}
function swapAd(slotEl, ad) {
  const current = slotEl.querySelector('.ad');
  if (!current) { renderAd(slotEl, ad); return; }
  current.classList.remove('show');
  setTimeout(() => renderAd(slotEl, ad), 380);
}
let adTick = 0;
function cycleAds() {
  const rightSlot = document.getElementById('adSlotRight');
  if (!rightSlot) return;
  adTick = (adTick + 1) % ADS.length;
  swapAd(rightSlot, ADS[adTick]);
}
function initAds() {
  const leftSlot  = document.getElementById('adSlotLeft');
  const rightSlot = document.getElementById('adSlotRight');
  if (!leftSlot || !rightSlot) return;
  setAds(localStorage.getItem("ms-ads") !== "off");
  renderAd(leftSlot,  PAYPAL_AD);
  renderAd(rightSlot, ADS[0]);
  adTick = 0;
  setInterval(cycleAds, 10000);
}

// Fade elements in as they scroll into view. Pages opt in with data-reveal;
// the home page tiles get it automatically.
function initReveal() {
  if (!("IntersectionObserver" in window) || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  // Only hide what starts below the fold, so nothing visible ever blinks out
  const els = [...document.querySelectorAll(".tile, [data-reveal]")]
    .filter(el => el.getBoundingClientRect().top > innerHeight);
  if (!els.length) return;
  let fired = false;
  const show = el => { el.classList.add("in"); io.unobserve(el); };
  const io = new IntersectionObserver(entries => {
    fired = true;
    let batch = 0;
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      e.target.style.setProperty("--reveal-delay", (batch++ * 0.07) + "s");
      show(e.target);
    });
  }, { rootMargin: "0px 0px -8% 0px" });
  els.forEach(el => { el.classList.add("reveal"); io.observe(el); });
  // Safety net: if the observer never reports (some embedded views), show everything
  setTimeout(() => { if (!fired) els.forEach(show); }, 1500);
}

initTheme();
// Some pages put the ad slots after their scripts, so wait for the full page.
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => { initAds(); initReveal(); });
else { initAds(); initReveal(); }
