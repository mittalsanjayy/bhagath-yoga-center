/* Keep business details and unconfirmed sample schedule data editable here. */
const SITE = {
  name: "Bhagath Yoga Classes",
  address: "6th A Main Road, HRBR Layout 2nd Block, Kalyan Nagar, Bengaluru, Karnataka 560043",
  phoneDisplay: "089716 69320",
  phoneNational: "08971669320",
  packages: {
    group: {
      name: "Group practice",
      description: "Ask about current group classes, availability and fees.",
      price: null,
      enquiryLabel: "Current rates on enquiry"
    },
    personal: {
      name: "Personal guidance",
      description: "Ask whether one-to-one sessions are available and how they’re arranged.",
      price: null,
      enquiryLabel: "Availability on enquiry"
    }
  },
  schedule: [
    { day: "Monday", time: "7:00 AM", className: "Hatha Yoga", type: "Hatha Yoga" },
    { day: "Tuesday", time: "6:30 PM", className: "Flexibility and mobility", type: "Flexibility and mobility" },
    { day: "Wednesday", time: "7:00 AM", className: "Hatha Yoga", type: "Hatha Yoga" },
    { day: "Thursday", time: "6:30 PM", className: "Stretching", type: "Stretching" },
    { day: "Friday", time: "7:00 AM", className: "Flexibility and mobility", type: "Flexibility and mobility" },
    { day: "Saturday", time: "8:00 AM", className: "Beginner-friendly sessions", type: "Hatha Yoga" },
    { day: "Sunday", time: "9:00 AM", className: "Stretching", type: "Stretching" }
  ]
};

function toIntlIndianMobile(value) {
  let digits = String(value).replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? `91${digits}` : null;
}

const intlPhone = toIntlIndianMobile(SITE.phoneNational);
if (!intlPhone) console.warn("SITE.phoneNational is not a valid Indian mobile number.");
const links = {
  tel: intlPhone ? `tel:+${intlPhone}` : "#contact",
  wa: intlPhone ? `https://wa.me/${intlPhone}` : "#contact",
  maps: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${SITE.name}, ${SITE.address}`)}`
};

document.querySelectorAll("[data-bind]").forEach(element => {
  const key = element.dataset.bind;
  element.textContent = key === "phone" ? SITE.phoneDisplay : SITE[key] || "";
});
document.querySelectorAll("[data-bind-href]").forEach(element => {
  const destination = links[element.dataset.bindHref];
  if (destination) element.href = destination;
});
Object.entries(SITE.packages).forEach(([key, item]) => {
  const name = document.querySelector(`[data-package-name="${key}"]`);
  const description = document.querySelector(`[data-package-description="${key}"]`);
  const price = document.querySelector(`[data-package-price="${key}"]`);
  if (name) name.textContent = item.name;
  if (description) description.textContent = item.description;
  if (price) price.textContent = item.price || item.enquiryLabel;
});
document.getElementById("year").textContent = new Date().getFullYear();

/* Responsive navigation */
const menuButton = document.querySelector(".menu-toggle");
const primaryNav = document.getElementById("primary-nav");
function setMenuOpen(open) {
  menuButton.setAttribute("aria-expanded", String(open));
  menuButton.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
  primaryNav.classList.toggle("is-open", open);
}
menuButton.addEventListener("click", () => {
  setMenuOpen(menuButton.getAttribute("aria-expanded") !== "true");
});
primaryNav.addEventListener("click", event => {
  if (event.target.closest("a")) setMenuOpen(false);
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && menuButton.getAttribute("aria-expanded") === "true") {
    setMenuOpen(false);
    menuButton.focus();
  }
});
window.addEventListener("resize", () => {
  if (window.innerWidth > 920) setMenuOpen(false);
});

/* Weekly timetable: these entries are examples, not current class availability. */
const scheduleList = document.getElementById("schedule-list");
const dayFilters = document.getElementById("day-filters");
const scheduleCount = document.getElementById("schedule-count");
let selectedDay = "all";
let selectedType = "all";
const scheduleDays = [...new Set(SITE.schedule.map(item => item.day))];
const dayOptions = [{ label: "All days", value: "all" }, ...scheduleDays.map(day => ({ label: day.slice(0, 3), value: day }))];

dayOptions.forEach(option => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `filter-chip${option.value === selectedDay ? " is-selected" : ""}`;
  button.dataset.dayFilter = option.value;
  button.setAttribute("aria-pressed", String(option.value === selectedDay));
  button.textContent = option.label;
  dayFilters.append(button);
});

function renderSchedule() {
  const entries = SITE.schedule.filter(item =>
    (selectedDay === "all" || item.day === selectedDay) &&
    (selectedType === "all" || item.type === selectedType)
  );
  scheduleList.replaceChildren();

  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "schedule-empty";
    empty.textContent = "No sample entries for this combination. Ask the studio about current options.";
    scheduleList.append(empty);
  } else {
    entries.forEach(item => {
      const row = document.createElement("article");
      row.className = "schedule-row";
      const time = document.createElement("span");
      time.className = "schedule-time";
      time.textContent = item.time;
      const name = document.createElement("span");
      name.className = "schedule-name";
      name.append(document.createTextNode(item.className));
      const detail = document.createElement("small");
      detail.textContent = `${item.day} · sample time`;
      name.append(detail);
      const ask = document.createElement("a");
      ask.className = "schedule-ask";
      ask.href = "#contact";
      ask.dataset.interest = item.className;
      ask.dataset.note = `I’d like to ask whether ${item.className} is offered on ${item.day} at ${item.time}.`;
      ask.textContent = "Ask about this time ↗";
      row.append(time, name, ask);
      scheduleList.append(row);
    });
  }
  scheduleCount.textContent = `${entries.length} sample ${entries.length === 1 ? "entry" : "entries"} · times are unconfirmed`;
}

dayFilters.addEventListener("click", event => {
  const button = event.target.closest("[data-day-filter]");
  if (!button) return;
  selectedDay = button.dataset.dayFilter;
  dayFilters.querySelectorAll("[data-day-filter]").forEach(option => {
    const selected = option === button;
    option.classList.toggle("is-selected", selected);
    option.setAttribute("aria-pressed", String(selected));
  });
  renderSchedule();
});
document.querySelectorAll("[data-type-filter]").forEach(button => {
  button.addEventListener("click", () => {
    selectedType = button.dataset.typeFilter;
    document.querySelectorAll("[data-type-filter]").forEach(option => {
      const selected = option === button;
      option.classList.toggle("is-selected", selected);
      option.setAttribute("aria-pressed", String(selected));
    });
    renderSchedule();
  });
});
renderSchedule();

/* Class links carry their context into the enquiry without submitting it. */
const interestField = document.getElementById("interest");
const messageField = document.getElementById("message");
document.addEventListener("click", event => {
  const link = event.target.closest("[data-interest]");
  if (!link) return;
  const interest = link.dataset.interest;
  if ([...interestField.options].some(option => option.value === interest)) interestField.value = interest;
  if (link.dataset.note) messageField.value = link.dataset.note;
});

/* Lightweight, keyboard-friendly image viewer. */
const lightbox = document.getElementById("lightbox");
const lightboxImage = document.getElementById("lightbox-image");
const closeLightbox = document.querySelector(".lightbox-close");
let lastGalleryTrigger = null;
document.querySelectorAll(".gallery-item").forEach(button => {
  button.addEventListener("click", () => {
    lastGalleryTrigger = button;
    lightboxImage.src = button.dataset.full;
    lightboxImage.alt = button.dataset.alt;
    lightbox.showModal();
    closeLightbox.focus();
  });
});
function closeImageViewer() {
  if (!lightbox.open) return;
  lightbox.close();
}
closeLightbox.addEventListener("click", closeImageViewer);
lightbox.addEventListener("click", event => {
  if (event.target === lightbox) closeImageViewer();
});
lightbox.addEventListener("close", () => {
  lightboxImage.removeAttribute("src");
  if (lastGalleryTrigger) lastGalleryTrigger.focus();
});

/* Scroll reveals are progressive enhancement and respect reduced motion. */
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
if ("IntersectionObserver" in window && !reducedMotion) {
  document.documentElement.classList.add("js");
  const revealObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.12 });
  document.querySelectorAll(".reveal").forEach(element => revealObserver.observe(element));
}

/* Validate locally, then offer a prefilled WhatsApp link for the visitor to review. */
const form = document.getElementById("enquiry-form");
const formStatus = document.getElementById("form-status");
const fields = {
  name: { element: form.elements.name, error: document.getElementById("name-error") },
  phone: { element: form.elements.phone, error: document.getElementById("phone-error") },
  message: { element: form.elements.message, error: document.getElementById("message-error") }
};
const validators = {
  name: value => value.trim().length >= 2 ? "" : "Please enter your name.",
  phone: value => toIntlIndianMobile(value) ? "" : "Enter a valid 10-digit Indian mobile number.",
  message: value => value.trim().length >= 5 ? "" : "Please add a short message (at least 5 characters)."
};
function validateField(key) {
  const field = fields[key];
  const message = validators[key](field.element.value);
  field.error.textContent = message;
  field.element.setAttribute("aria-invalid", String(Boolean(message)));
  return !message;
}
Object.entries(fields).forEach(([key, field]) => {
  field.element.addEventListener("input", () => {
    if (field.element.getAttribute("aria-invalid") === "true") validateField(key);
    formStatus.replaceChildren();
  });
});
form.addEventListener("submit", event => {
  event.preventDefault();
  const valid = Object.keys(fields).map(validateField).every(Boolean);
  if (!valid) {
    const firstInvalid = form.querySelector('[aria-invalid="true"]');
    firstInvalid.focus();
    formStatus.textContent = "";
    return;
  }
  if (!intlPhone) {
    formStatus.textContent = "WhatsApp contact is unavailable. Please use the phone number shown on this page.";
    return;
  }
  const interest = interestField.value;
  const text = `Hello, I am ${form.elements.name.value.trim()} (${form.elements.phone.value.trim()}).${interest ? ` I am interested in ${interest}.` : ""} ${form.elements.message.value.trim()}`;
  const link = document.createElement("a");
  link.href = `${links.wa}?text=${encodeURIComponent(text)}`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "Open WhatsApp to review and send your message ↗";
  formStatus.replaceChildren(document.createTextNode("Your message has not been sent. "), link);
});
