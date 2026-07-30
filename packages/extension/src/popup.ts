function paint(status: string, url: string) {
  const statusEl = document.getElementById("status");
  const urlEl = document.getElementById("url");
  const dot = document.getElementById("dot");
  if (!statusEl || !urlEl || !dot) return;

  statusEl.textContent = status;
  urlEl.textContent = url;
  dot.classList.remove("ok", "warn");
  if (status === "connected") dot.classList.add("ok");
  else if (status === "connecting") dot.classList.add("warn");
}

async function refresh() {
  const res = await chrome.runtime.sendMessage({ type: "get-status" });
  paint(res?.status ?? "disconnected", res?.url ?? "ws://127.0.0.1:17373");
}

document.getElementById("reconnect")?.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "reconnect" });
  setTimeout(() => {
    void refresh();
  }, 400);
});

void refresh();
setInterval(() => {
  void refresh();
}, 1500);
