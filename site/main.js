// Points the big "Download" button at the right installer for the visitor's computer,
// and marks that system's card in the download section.

const LATEST = "https://github.com/MaurerKrisztian/select-reader/releases/latest/download/";

const INSTALLERS = {
  windows: { label: "Download for Windows", file: "select-reader-setup.exe", note: "Free · Windows 10 and 11" },
  linux: { label: "Download for Linux", file: "select-reader_amd64.deb", note: "Free · .deb for Ubuntu and Debian · AppImage below" },
};

function detectSystem() {
  const platform = (navigator.userAgentData?.platform || navigator.userAgent).toLowerCase();
  if (platform.includes("mac")) return "mac";
  if (platform.includes("win")) return "windows";
  if (platform.includes("linux") && !platform.includes("android")) return "linux";
  return null;
}

const system = detectSystem();
const installer = INSTALLERS[system];

if (installer) {
  const button = document.getElementById("main-download");
  button.href = LATEST + installer.file;
  button.querySelector("span").textContent = installer.label;
  document.getElementById("download-note").textContent = installer.note;
}

document.querySelector(`.download[data-os="${system}"]`)?.classList.add("yours");
