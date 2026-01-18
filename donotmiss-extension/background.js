// Background service worker - handles context menu and messaging

// Create context menu on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'donotmiss-capture',
    title: 'Add to DoNotMiss',
    contexts: ['selection']
  });
});

// Handle context menu click
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'donotmiss-capture' && info.selectionText) {
    // Detect source type based on URL
    const source = detectSource(tab.url);
    
    const taskData = {
      text: info.selectionText.trim(),
      source: source,
      url: tab.url,
      title: tab.title
    };

    // Check if content script is available by pinging it
    let contentScriptReady = false;
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'ping' });
      contentScriptReady = response && response.pong;
    } catch (e) {
      contentScriptReady = false;
    }

    if (contentScriptReady) {
      // Content script available - show modal
      chrome.tabs.sendMessage(tab.id, {
        action: 'showCaptureModal',
        data: taskData
      });
    } else {
      // Content script blocked - use popup fallback
      console.log('Content script blocked, using popup fallback');
      
      // Store task data for popup to retrieve
      await chrome.storage.local.set({ captureTask: taskData });
      
      // Open popup window
      chrome.windows.create({
        url: 'popup/capture.html',
        type: 'popup',
        width: 400,
        height: 300,
        top: 100,
        left: Math.round((screen.width - 400) / 2)
      });
    }
  }
});

// Detect source type from URL
function detectSource(url) {
  if (!url) return 'web';
  
  const lowerUrl = url.toLowerCase();
  
  if (lowerUrl.includes('mail.google.com') || 
      lowerUrl.includes('outlook.') || 
      lowerUrl.includes('/mail')) {
    return 'email';
  }
  
  if (lowerUrl.includes('slack.com') || 
      lowerUrl.includes('teams.microsoft.com') || 
      lowerUrl.includes('discord.com')) {
    return 'chat';
  }
  
  if (lowerUrl.includes('atlassian.net') || 
      lowerUrl.includes('jira')) {
    return 'jira';
  }
  
  return 'web';
}

// Listen for messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'submitTask') {
    submitTaskToBackend(request.task)
      .then(result => sendResponse({ success: true, result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep channel open for async response
  }
});

// Flask backend endpoint (change for production)
const BACKEND_URL = 'https://donotmiss-backend.onrender.com/api';

// Submit task to Flask backend for storage
// The Jira Forge app will sync from the backend and create Jira issues
async function submitTaskToBackend(task) {
  console.log('📤 Sending task to backend:', task);

  // Map extension payload to Flask API expected shape
  const payload = {
    text: task.description || task.title,
    title: task.title,
    description: task.description,
    source: task.source || 'web',
    url: task.url,
    priority: task.priority || 'medium',
    deadline: task.deadline || null,
    createdAt: task.timestamp || new Date().toISOString(),
    metadata: {
      userApproved: task.userApproved,
      capturedVia: 'extension'
    }
  };

  // Store task in backend - Jira Forge app will sync and create issues
  const response = await fetch(`${BACKEND_URL}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || `Backend error: ${response.status}`);
  }

  console.log('✅ Task stored in backend:', result);
  console.log('📋 Open Jira DoNotMiss panel to sync and create Jira issues');

  return {
    id: result.id,
    status: result.status,
    message: 'Task saved! Open Jira to sync and create issue.'
  };
}
