// Popup script - handles the extension popup UI with AI-detected tasks

// Flask backend endpoint (same as background.js)
const BACKEND_URL = 'https://donotmiss-backend.onrender.com/api';

// Wake-up configuration
const WAKEUP_CHECK_INTERVAL = 3000; // 3 seconds
const WAKEUP_TIMEOUT = 10000; // 10 seconds per request timeout

// Check if backend is awake
async function checkBackendHealth() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), WAKEUP_TIMEOUT);
  
  try {
    const response = await fetch(`${BACKEND_URL}/health`, {
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return response.ok;
  } catch (e) {
    clearTimeout(timeoutId);
    return false;
  }
}

// Wake up the backend with retry logic
async function wakeUpBackend() {
  const wakeupScreen = document.getElementById('wakeup-screen');
  const mainContent = document.getElementById('main-content');
  const attemptText = document.getElementById('wakeup-attempt');
  
  let attempt = 0;
  
  // First quick check - maybe backend is already awake
  const isAwake = await checkBackendHealth();
  if (isAwake) {
    return true;
  }
  
  // Backend is sleeping, show wake-up screen
  wakeupScreen.style.display = 'flex';
  mainContent.style.display = 'none';
  
  // Keep trying until backend wakes up
  return new Promise((resolve) => {
    const checkInterval = setInterval(async () => {
      attempt++;
      attemptText.textContent = `Attempt ${attempt} • Checking every 3 seconds...`;
      
      const awake = await checkBackendHealth();
      if (awake) {
        clearInterval(checkInterval);
        wakeupScreen.style.display = 'none';
        mainContent.style.display = 'block';
        updateStatus(true);
        resolve(true);
      }
    }, WAKEUP_CHECK_INTERVAL);
    
    // Also do immediate check
    checkBackendHealth().then(awake => {
      if (awake) {
        clearInterval(checkInterval);
        wakeupScreen.style.display = 'none';
        mainContent.style.display = 'block';
        updateStatus(true);
        resolve(true);
      }
    });
  });
}

// Update connection status in footer
function updateStatus(connected) {
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  
  if (connected) {
    statusDot.classList.remove('disconnected');
    statusText.textContent = 'Ready to sync with Jira';
  } else {
    statusDot.classList.add('disconnected');
    statusText.textContent = 'Backend offline';
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  // First wake up the backend if needed
  await wakeUpBackend();
  // Then load tasks
  await loadTasks();
});

async function loadTasks() {
  const emptyState = document.getElementById('empty-state');
  const tasksList = document.getElementById('tasks-list');
  const tasksContainer = document.getElementById('tasks-container');
  const taskCount = document.getElementById('task-count');

  let tasks = [];

  // Try to fetch pending tasks from Flask backend
  try {
    const response = await fetch(`${BACKEND_URL}/tasks?status=pending`);
    if (response.ok) {
      const backendTasks = await response.json();
      tasks = backendTasks.map(t => ({
        id: t.id,
        text: t.description || t.text,
        source: t.source,
        url: t.url,
        detectedAt: t.createdAt
      }));
    }
  } catch (e) {
    console.warn('Could not reach backend, using local storage:', e.message);
  }

  // If backend returned nothing, check local storage
  if (tasks.length === 0) {
    const result = await chrome.storage.local.get('pendingTasks');
    tasks = result.pendingTasks || [];
  }

  if (tasks.length === 0) {
    emptyState.style.display = 'block';
    tasksList.style.display = 'none';
    return;
  }

  emptyState.style.display = 'none';
  tasksList.style.display = 'flex';
  taskCount.textContent = tasks.length;

  // Render tasks
  tasksContainer.innerHTML = tasks.map((task, index) => `
    <div class="task-card" data-index="${index}">
      <div class="task-text">${escapeHtml(task.text)}</div>
      <div class="task-meta">
        <span class="task-source ${task.source}">
          ${getSourceIcon(task.source)} ${task.source}
        </span>
        <div class="task-actions">
          <button class="btn-small btn-dismiss" data-action="dismiss" data-index="${index}">
            Dismiss
          </button>
          <button class="btn-small btn-add" data-action="add" data-index="${index}">
            Add to Jira
          </button>
        </div>
      </div>
    </div>
  `).join('');

  // Bind click handlers
  tasksContainer.addEventListener('click', handleTaskAction);
}

// Handle task actions (add/dismiss)
async function handleTaskAction(e) {
  const button = e.target.closest('button');
  if (!button) return;

  const action = button.dataset.action;
  const index = parseInt(button.dataset.index);
  const card = button.closest('.task-card');

  // Get tasks from storage (fallback list)
  const result = await chrome.storage.local.get('pendingTasks');
  const tasks = result.pendingTasks || [];
  const task = tasks[index];

  if (action === 'add') {
    // Show loading state
    button.textContent = '...';
    button.disabled = true;

    // Auto-generate title
    const title = task.text.length > 50 
      ? task.text.substring(0, 50).trim() + '...' 
      : task.text.trim();

    // Submit task
    const response = await chrome.runtime.sendMessage({
      action: 'submitTask',
      task: {
        title: title,
        description: task.text,
        deadline: null,
        priority: 'medium',
        source: task.source,
        url: task.url,
        timestamp: new Date().toISOString(),
        userApproved: true
      }
    });

    if (response.success) {
      // Show success briefly
      button.textContent = '✓';
      button.style.background = '#36B37E';
      
      // Remove from list with animation
      setTimeout(() => {
        card.classList.add('removing');
      }, 300);
      
      await new Promise(r => setTimeout(r, 500));
    }
  } else {
    // Dismiss - animate out and delete from backend if task has backend id
    card.classList.add('removing');
    await new Promise(r => setTimeout(r, 200));

    // If task came from backend (has string id starting with 'task-'), delete it
    if (task && typeof task.id === 'string' && task.id.startsWith('task-')) {
      try {
        await fetch(`${BACKEND_URL}/tasks/${task.id}`, { method: 'DELETE' });
      } catch (e) {
        console.warn('Could not delete task from backend:', e.message);
      }
    }
  }

  // Remove task from local storage
  tasks.splice(index, 1);
  await chrome.storage.local.set({ pendingTasks: tasks });

  // Reload UI
  await loadTasks();
}

// Helper: escape HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Helper: get source icon
function getSourceIcon(source) {
  const icons = {
    email: '📧',
    chat: '💬',
    jira: '🎫',
    web: '🌐'
  };
  return icons[source] || icons.web;
}
