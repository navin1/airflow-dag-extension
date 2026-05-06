// Open the DAG Viewer in a new tab when the extension icon is clicked.
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
});
