import { api, isLoggedIn } from "./shared/api";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
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

if (await isLoggedIn()) showRoles();
