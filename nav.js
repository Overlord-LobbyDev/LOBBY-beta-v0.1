// ============================================================
//  nav.js  —  smooth page navigation helper
// ============================================================

// Apply incoming transition based on query param
// Use DOMContentLoaded to ensure body exists
(function () {
  function applyTransition() {
    const params     = new URLSearchParams(window.location.search);
    const transition = params.get("transition") || "fade";
    if (transition === "up")   document.body.classList.add("slide-up");
    if (transition === "down") document.body.classList.add("slide-down");
  }
  if (document.body) {
    applyTransition();
  } else {
    document.addEventListener("DOMContentLoaded", applyTransition);
  }
})();

// Smooth navigate — animates out then loads new page
function smoothNavigate(page, direction = "fade") {
  const t = localStorage.getItem("vh_token") || sessionStorage.getItem("vh_token");
  if (t) localStorage.setItem("vh_token", t);

  const leaveClass = direction === "down" ? "leaving-down" : "leaving";
  if (document.body) document.body.classList.add(leaveClass);

  setTimeout(() => {
    if (window.electronAPI?.navigate) {
      window.electronAPI.navigate(page, direction);
    } else {
      window.location.href = page;
    }
  }, 150);
}
// Additional functions for UI interactions
function showMyProfile() {
  if (window._spSwitchCat) window._spSwitchCat("profile");
  else if (window.openPanel) window.openPanel();
}

function _doInviteToServer() {
  const serverId = window._selectedServerId;
  if (!serverId) {
    alert("Please select a server first");
    return;
  }
  const invitePanel = document.getElementById("invitePanel");
  if (invitePanel) invitePanel.style.display = "block";
}
