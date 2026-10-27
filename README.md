# Bhagath Yoga Classes

A responsive, editorial-style website for Bhagath Yoga Classes in HRBR Layout, Kalyan Nagar, Bengaluru. Built with HTML, CSS and vanilla JavaScript; there is no build step or backend.

## Run locally

Open `index.html` in a browser, or serve this folder with `python -m http.server`. Google Fonts need an internet connection; the page falls back to system fonts when offline.

## Edit business information

Update the `SITE` object at the top of `script.js`:

- `address`, `phoneDisplay` and `phoneNational` drive the contact details, call link, WhatsApp link and map directions.
- `schedule` contains **sample entries only**. Replace the example days and times with confirmed class information before presenting them as a live timetable. The page labels all entries as unconfirmed and does not book places.
- `packages` contains the editable package names, descriptions and prices. Prices are unset by default and the page asks visitors to enquire.

The class descriptions and current program list are in `index.html`. Update both the relevant enquiry options and the timetable practice filter if the studio changes its offerings.

## Images and publication checklist

The original project contained labelled SVG placeholders rather than photographs. The redesigned page uses locally stored editorial yoga imagery in `assets/hero.jpg`, `assets/studio.jpg`, `assets/movement.jpg` and `assets/practice.jpg`. These are representative images, **not** photos of Bhagath Yoga Classes or its instructor. Replace them with approved studio and instructor photographs before describing them as authentic studio imagery. Update the image `alt` text and dimensions when changing assets.

Before publishing, confirm the timetable, class durations and suitability, fees, equipment availability, instructor name and qualifications, business hours, and public review links. No hours, prices, credentials, medical outcomes or student testimonials are invented on the page. Add social links only when the studio provides its official profiles.

## Enquiry form

The form validates name, Indian mobile number and message in the browser, then creates a prefilled WhatsApp link for the visitor to review and send. It does not submit, store or transmit form data itself. There is no booking, payment, availability check or backend integration.

## Included assets

- `assets/hero.jpg`, `studio.jpg`, `movement.jpg`, `practice.jpg`: representative editorial yoga imagery.
- `assets/favicon.svg`: Bhagath Yoga botanical mark.
- Existing SVG placeholder assets are retained for reference; they are not used in the redesigned page.
