import Resolver from '@forge/resolver';
import { storage, route, fetch } from '@forge/api';
import api from '@forge/api';

const resolver = new Resolver();

// Flask backend URL - tasks are stored in PostgreSQL via this backend
const FLASK_BACKEND_URL = process.env.FLASK_BACKEND_URL || 'https://donotmiss-backend.onrender.com';

// Priority mapping for Jira
const PRIORITY_MAP = {
  'highest': '1',
  'high': '2',
  'medium': '3',
  'low': '4'
};

// ============================================================
// Task Operations - Read from Backend, Create in Jira
// ============================================================

// Get all tasks from the backend database
resolver.define('getTasks', async () => {
  const backendUrl = await storage.get('flaskBackendUrl') || FLASK_BACKEND_URL;
  
  try {
    const response = await fetch(`${backendUrl}/api/tasks`);
    if (!response.ok) {
      console.error('Failed to fetch tasks from backend');
      return [];
    }
    const tasks = await response.json();
    return tasks;
  } catch (error) {
    console.error('Error fetching tasks:', error);
    return [];
  }
});

// Sync tasks and update Jira status for sent tasks
resolver.define('syncTasks', async () => {
  const backendUrl = await storage.get('flaskBackendUrl') || FLASK_BACKEND_URL;
  
  try {
    const response = await fetch(`${backendUrl}/api/tasks`);
    if (!response.ok) {
      return { success: false, error: 'Failed to fetch tasks' };
    }
    
    const tasks = await response.json();
    
    // Update Jira status for sent tasks
    for (const task of tasks) {
      if (task.status === 'sent' && task.jiraKey) {
        try {
          const jiraResponse = await api.asUser().requestJira(
            route`/rest/api/3/issue/${task.jiraKey}?fields=status`,
            { method: 'GET' }
          );
          if (jiraResponse.ok) {
            const issue = await jiraResponse.json();
            task.jiraStatus = issue.fields.status?.name || 'Unknown';
          }
        } catch (e) {
          // Ignore Jira sync errors
        }
      }
    }
    
    return { success: true, tasks };
  } catch (error) {
    console.error('Sync error:', error);
    return { success: false, error: error.message };
  }
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

// Send task to Jira - creates a real Jira issue
resolver.define('sendToJira', async ({ payload, context }) => {
  const backendUrl = await storage.get('flaskBackendUrl') || FLASK_BACKEND_URL;
  const { taskId, assigneeId } = payload;
  
  // First, get the task from backend
  let task;
  try {
    const taskResponse = await fetch(`${backendUrl}/api/tasks/${taskId}`);
    if (!taskResponse.ok) {
      return { success: false, error: 'Task not found' };
    }
    task = await taskResponse.json();
  } catch (error) {
    return { success: false, error: 'Failed to fetch task' };
  }
  
  const projectKey = context.extension.project.key;
  
  try {
    // Build Jira issue
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
                { type: 'text', text: `📍 Source: ${(task.source || 'web').toUpperCase()} | ` },
                { type: 'text', text: task.url || 'N/A', marks: task.url ? [{ type: 'link', attrs: { href: task.url } }] : [] }
              ]
            },
            {
              type: 'paragraph',
              content: [{ type: 'text', text: '✨ Created via DoNotMiss' }]
            }
          ]
        },
        issuetype: { name: 'Task' },
        priority: { id: PRIORITY_MAP[task.priority] || '3' },
        labels: ['donotmiss', `source-${task.source || 'web'}`]
      }
    };
    
    // Add deadline if exists
    if (task.deadline) {
      issueBody.fields.duedate = task.deadline;
    }
    
    // Assign if specified
    if (assigneeId) {
      issueBody.fields.assignee = { accountId: assigneeId };
    }
    
    // Create issue in Jira
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
    
    // Mark task as sent in backend database
    await fetch(`${backendUrl}/api/tasks/${taskId}/mark-sent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        jiraKey: result.key,
        jiraUrl: `https://${context.siteUrl}/browse/${result.key}`
      })
    });
    
    return { success: true, jiraKey: result.key };
  } catch (error) {
    console.error('Error creating Jira issue:', error);
    return { success: false, error: error.message };
  }
});

// Decline a task - update status in backend
resolver.define('declineTask', async ({ payload }) => {
  const backendUrl = await storage.get('flaskBackendUrl') || FLASK_BACKEND_URL;
  const { taskId } = payload;
  
  try {
    const response = await fetch(`${backendUrl}/api/tasks/${taskId}/decline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    
    return { success: response.ok };
  } catch (error) {
    console.error('Failed to decline task:', error);
    return { success: false, error: error.message };
  }
});

// Restore a declined task - update status in backend
resolver.define('restoreTask', async ({ payload }) => {
  const backendUrl = await storage.get('flaskBackendUrl') || FLASK_BACKEND_URL;
  const { taskId } = payload;
  
  try {
    const response = await fetch(`${backendUrl}/api/tasks/${taskId}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    
    return { success: response.ok };
  } catch (error) {
    console.error('Failed to restore task:', error);
    return { success: false, error: error.message };
  }
});

// Delete a task permanently - remove from backend
resolver.define('deleteTask', async ({ payload }) => {
  const backendUrl = await storage.get('flaskBackendUrl') || FLASK_BACKEND_URL;
  const { taskId } = payload;
  
  try {
    const response = await fetch(`${backendUrl}/api/tasks/${taskId}`, {
      method: 'DELETE'
    });
    
    return { success: response.ok || response.status === 404 };
  } catch (error) {
    console.error('Failed to delete task:', error);
    return { success: false, error: error.message };
  }
});

// Clear all tasks (admin function)
resolver.define('clearTasks', async () => {
  const backendUrl = await storage.get('flaskBackendUrl') || FLASK_BACKEND_URL;
  
  try {
    const response = await fetch(`${backendUrl}/api/tasks`, {
      method: 'DELETE'
    });
    
    return { success: response.ok };
  } catch (error) {
    console.error('Failed to clear tasks:', error);
    return { success: false, error: error.message };
  }
});

// ============================================================
// Configuration
// ============================================================

resolver.define('getBackendUrl', async () => {
  const url = await storage.get('flaskBackendUrl') || FLASK_BACKEND_URL;
  return { url };
});

resolver.define('setBackendUrl', async ({ payload }) => {
  await storage.set('flaskBackendUrl', payload.url);
  return { success: true };
});

export const handler = resolver.getDefinitions();
