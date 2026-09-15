"use strict";

const checkbox = document.getElementById("unblur");
chrome.storage.local.get({ unblurEnabled: true }, ({ unblurEnabled }) => {
  checkbox.checked = !!unblurEnabled;
});
checkbox.addEventListener("change", () => {
  chrome.storage.local.set({ unblurEnabled: checkbox.checked });
});
