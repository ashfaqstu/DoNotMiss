import Resolver from '@forge/resolver';
import { storage, route, fetch } from '@forge/api';
import api from '@forge/api';

const resolver = new Resolver();

// Flask backend URL - change to your deployed URL or ngrok tunnel for production
const FLASK_BACKEND_URL = process.env.FLASK_BACKEND_URL || 'https://donotmiss-backend.onrender.com';

// Priority mapping
const PRIORITY_MAP = {
  'highest': '1',
  'high': '2',
  'medium': '3',
  'low': '4'
};

// Get all tasks with Jira status sync
resolver.define('getTasks', async ({ context }) => {
  const tasks = await storage.get('tasks') || [];
  
  // Sync Jira status for sent tasks
  const updatedTasks = await Promise.all(tasks.map(async (task) => {
    if (task.status === 'sent' && task.jiraKey) {
      try {
        const response = await api.asUser().requestJira(
          route`/rest/api/3/issue/${task.jiraKey}?fields=status,assignee,priority,duedate`,
          { method: 'GET' }
        );
        if (response.ok) {
          const issue = await response.json();
          task.jiraStatus = issue.fields.status?.name || 'Unknown';
          task.jiraStatusCategory = issue.fields.status?.statusCategory?.key || 'undefined';
          task.assignee = issue.fields.assignee?.displayName || null;
          task.assigneeAvatar = issue.fields.assignee?.avatarUrls?.['24x24'] || null;
          task.jiraPriority = issue.fields.priority?.name || null;
          task.dueDate = issue.fields.duedate || task.deadline;
        }
      } catch (e) {
        console.log('Could not sync task:', task.jiraKey);
      }
    }
    return task;
  }));
  
  await storage.set('tasks', updatedTasks);
  return updatedTasks;
});

// Add a new task
resolver.define('addTask', async ({ payload }) => {
  const tasks = await storage.get('tasks') || [];
  
  const newTask = {
    id: `task-${Date.now()}`,
    title: payload.title,
    description: payload.description,
    source: payload.source,
    url: payload.url,
    priority: payload.priority || 'medium',
    deadline: payload.deadline || null,
    status: 'pending',
    createdAt: new Date().toISOString(),
    createdVia: 'donotmiss'
  };
  
  tasks.unshift(newTask);
  await storage.set('tasks', tasks);
  
  return { success: true, task: newTask };
});

// Delete a task (permanently)
resolver.define('deleteTask', async ({ payload }) => {
  const tasks = await storage.get('tasks') || [];
  const filtered = tasks.filter(t => t.id !== payload.taskId);
  await storage.set('tasks', filtered);
  return { success: true };
});

// Decline a task (move to trash)
resolver.define('declineTask', async ({ payload }) => {
  const tasks = await storage.get('tasks') || [];
  const taskIndex = tasks.findIndex(t => t.id === payload.taskId);
  
  if (taskIndex === -1) {
    return { success: false, error: 'Task not found' };
  }
  
  tasks[taskIndex].status = 'declined';
  tasks[taskIndex].declinedAt = new Date().toISOString();
  
  await storage.set('tasks', tasks);
  return { success: true, task: tasks[taskIndex] };
});

// Restore a declined task back to pending
resolver.define('restoreTask', async ({ payload }) => {
  const tasks = await storage.get('tasks') || [];
  const taskIndex = tasks.findIndex(t => t.id === payload.taskId);
  
  if (taskIndex === -1) {
    return { success: false, error: 'Task not found' };
  }
  
  tasks[taskIndex].status = 'pending';
  delete tasks[taskIndex].declinedAt;
  
  await storage.set('tasks', tasks);
  return { success: true, task: tasks[taskIndex] };
});

// Get project users for assignment
resolver.define('getProjectUsers', async ({ context }) => {
  try {
    const projectKey = context.extension.project.key;
    const response = await api.asUser().requestJira(
      route`/rest/api/3/user/assignable/search?project=${projectKey}&maxResults=50`,
      { method: 'GET' }
    );
    if (response.ok) {
      const users = await response.json();
      return users.map(u => ({
        accountId: u.accountId,
        displayName: u.displayName,
        avatar: u.avatarUrls?.['24x24']
      }));
    }
    return [];
  } catch (e) {
    console.error('Failed to get users:', e);
    return [];
  }
});

// Send task to Jira (create real issue)
resolver.define('sendToJira', async ({ payload, context }) => {
  const tasks = await storage.get('tasks') || [];
  const taskIndex = tasks.findIndex(t => t.id === payload.taskId);
  
  if (taskIndex === -1) {
    return { success: false, error: 'Task not found' };
  }
  
  const task = tasks[taskIndex];
  const projectKey = context.extension.project.key;
  
  try {
    const issueBody = {
      fields: {
        project: { key: projectKey },
        summary: task.title,
        description: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: task.description || task.title }]
            },
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: `📍 Source: ${task.source.toUpperCase()} | ` },
                { type: 'text', text: task.url, marks: [{ type: 'link', attrs: { href: task.url } }] }
              ]
            },
            {
              type: 'paragraph',
              content: [{ type: 'text', text: '✨ Created via DoNotMiss - AI Task Capture' }]
            }
          ]
        },
        issuetype: { name: 'Task' },
        priority: { id: PRIORITY_MAP[task.priority] || '3' },
        labels: ['donotmiss', `source-${task.source}`]
      }
    };
    
    if (task.deadline) {
      issueBody.fields.duedate = task.deadline;
    }
    
    // Assign if specified
    if (payload.assigneeId) {
      issueBody.fields.assignee = { accountId: payload.assigneeId };
    }
    
    const response = await api.asUser().requestJira(route`/rest/api/3/issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(issueBody)
    });
    
    const result = await response.json();
    
    if (!response.ok) {
      console.error('Jira API error:', result);
      return { success: false, error: result.errorMessages?.join(', ') || 'Failed to create issue' };
    }
    
    // Add system comment to the issue with source link
    const commentBody = {
      body: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '✨ This task was captured using ' },
              { type: 'text', text: 'DoNotMiss', marks: [{ type: 'strong' }] },
              { type: 'text', text: ` from ${task.source}.` }
            ]
          },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '🔗 Source: ' },
              { type: 'text', text: task.url, marks: [{ type: 'link', attrs: { href: task.url } }] }
            ]
          }
        ]
      }
    };
    
    await api.asUser().requestJira(route`/rest/api/3/issue/${result.key}/comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(commentBody)
    });
    
    tasks[taskIndex].status = 'sent';
    tasks[taskIndex].jiraKey = result.key;
    tasks[taskIndex].jiraId = result.id;
    tasks[taskIndex].jiraStatus = 'To Do';
    tasks[taskIndex].jiraStatusCategory = 'new';
    tasks[taskIndex].sentAt = new Date().toISOString();
    
    await storage.set('tasks', tasks);
    
    return { success: true, jiraKey: result.key, task: tasks[taskIndex] };
  } catch (error) {
    console.error('Error creating Jira issue:', error);
    return { success: false, error: error.message };
  }
});

// Transition issue (change status)
resolver.define('transitionIssue', async ({ payload }) => {
  const { jiraKey, transitionId } = payload;
  
  try {
    const response = await api.asUser().requestJira(
      route`/rest/api/3/issue/${jiraKey}/transitions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transition: { id: transitionId } })
      }
    );
    
    return { success: response.ok };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Get available transitions for an issue
resolver.define('getTransitions', async ({ payload }) => {
  try {
    const response = await api.asUser().requestJira(
      route`/rest/api/3/issue/${payload.jiraKey}/transitions`,
      { method: 'GET' }
    );
    if (response.ok) {
      const data = await response.json();
      return data.transitions || [];
    }
    return [];
  } catch (e) {
    return [];
  }
});

// Assign issue to user
resolver.define('assignIssue', async ({ payload }) => {
  try {
    const response = await api.asUser().requestJira(
      route`/rest/api/3/issue/${payload.jiraKey}/assignee`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: payload.accountId })
      }
    );
    return { success: response.ok };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Clear all tasks (for demo reset)
resolver.define('clearTasks', async () => {
  await storage.set('tasks', []);
  return { success: true };
});



// ============================================================
// Flask Backend Integration
// ============================================================

// Get/set the Flask backend URL (for configuration)
resolver.define('getBackendUrl', async () => {
  const url = await storage.get('flaskBackendUrl') || FLASK_BACKEND_URL;
  return { url };
});

resolver.define('setBackendUrl', async ({ payload }) => {
  await storage.set('flaskBackendUrl', payload.url);
  return { success: true };
});

// Fetch tasks from Flask backend
resolver.define('fetchFromBackend', async () => {
  const backendUrl = await storage.get('flaskBackendUrl') || FLASK_BACKEND_URL;
  
  try {
    const response = await fetch(`${backendUrl}/api/tasks?status=pending`);
    if (!response.ok) {
      return { success: false, error: `Backend returned ${response.status}` };
    }
    const backendTasks = await response.json();
    return { success: true, tasks: backendTasks };
  } catch (error) {
    console.error('Failed to fetch from Flask backend:', error);
    return { success: false, error: error.message };
  }
});

// Sync tasks from Flask backend into Forge storage
resolver.define('syncFromBackend', async () => {
  const backendUrl = await storage.get('flaskBackendUrl') || FLASK_BACKEND_URL;
  
  try {
    const response = await fetch(`${backendUrl}/api/tasks?status=pending`);
    if (!response.ok) {
      return { success: false, error: `Backend returned ${response.status}` };
    }
    
    const backendTasks = await response.json();
    const existingTasks = await storage.get('tasks') || [];
    
    // Get IDs of tasks already in Forge
    const existingIds = new Set(existingTasks.map(t => t.id));
    
    // Add new tasks from backend that don't exist in Forge
    let addedCount = 0;
    for (const bt of backendTasks) {
      if (!existingIds.has(bt.id)) {
        existingTasks.unshift({
          id: bt.id,
          title: bt.title || bt.text?.substring(0, 80) || 'Untitled',
          description: bt.description || bt.text || '',
          source: bt.source || 'web',
          url: bt.url || '',
          priority: bt.priority || 'medium',
          deadline: bt.metadata?.deadline || null,
          status: 'pending',
          createdAt: bt.createdAt || new Date().toISOString(),
          createdVia: 'donotmiss-flask'
        });
        addedCount++;
      }
    }
    
    await storage.set('tasks', existingTasks);
    
    return { success: true, added: addedCount, total: existingTasks.length };
  } catch (error) {
    console.error('Failed to sync from Flask backend:', error);
    return { success: false, error: error.message };
  }
});

// Mark task as sent on Flask backend after Jira creation
resolver.define('markSentOnBackend', async ({ payload }) => {
  const backendUrl = await storage.get('flaskBackendUrl') || FLASK_BACKEND_URL;
  const { taskId } = payload;
  
  try {
    const response = await fetch(`${backendUrl}/api/tasks/${taskId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    
    return { success: response.ok };
  } catch (error) {
    console.error('Failed to mark sent on backend:', error);
    return { success: false, error: error.message };
  }
});

// Delete task from Flask backend
resolver.define('deleteFromBackend', async ({ payload }) => {
  const backendUrl = await storage.get('flaskBackendUrl') || FLASK_BACKEND_URL;
  const { taskId } = payload;
  
  try {
    const response = await fetch(`${backendUrl}/api/tasks/${taskId}`, {
      method: 'DELETE'
    });
    
    return { success: response.ok || response.status === 404 };
  } catch (error) {
    console.error('Failed to delete from backend:', error);
    return { success: false, error: error.message };
  }
});

export const handler = resolver.getDefinitions();
