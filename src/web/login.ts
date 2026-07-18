import { api, isLoggedIn } from "./shared/api";
import { $ } from "./shared/dom-helpers";

/**
 * Login page: password form that swaps to a role picker (camera/control/clips links) on success,
 * without a page reload — and skips straight to the role picker if a valid session cookie is
 * already present.
 */

const showRoles = () => {
  $("login-card").hidden = true;
  $("roles").hidden = false;
};

$("go-camera").onclick = () => (location.href = "/camera");
$("go-control").onclick = () => (location.href = "/control");
$("go-clips").onclick = () => (location.href = "/clips");

$<HTMLFormElement>("login-form").onsubmit = async (ev) => {
  ev.preventDefault();
  $("login-error").textContent = "";
  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ password: $<HTMLInputElement>("password").value }),
    });
    showRoles();
  } catch (e) {
    $("login-error").textContent = e instanceof Error ? e.message : "erro";
  }
};

// Returning user with a still-valid session cookie: skip the password form entirely.
if (await isLoggedIn()) showRoles();
