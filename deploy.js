const line = document.getElementById("line");

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "deploy-progress" && message.text) {
    line.textContent = message.text;
  }
});
