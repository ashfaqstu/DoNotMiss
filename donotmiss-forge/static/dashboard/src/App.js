import { useEffect, useState } from 'react';
import { invoke, router } from '@forge/bridge';
import './App.css';

function App() {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [users, setUsers] = useState([]);
  const [actionLoading, setActionLoading] = useState({});
  const [showAssignModal, setShowAssignModal] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState(null);

  useEffect(() => {
    loadTasks();
    loadUsers();
  }, []);

  const openIssue = async (issueKey) => {
    try {
      // Use router.navigate for internal Jira navigation
      await router.navigate(`/browse/${issueKey}`);
    } catch (e) {
      // Fallback: open in new tab
      window.open(`https://ahammadshawki8.atlassian.net/browse/${issueKey}`, '_blank');
    }
  };

  const loadTasks = async (showLoading = true) => {
    if (showLoading) setLoading(true);
    try {
      const data = await invoke('getTasks');
      setTasks(data || []);
    } catch (error) {
      console.error('Failed to load tasks:', error);
    }
    if (showLoading) setLoading(false);
  };

  const refreshTasks = async () => {
    try {
      const data = await invoke('getTasks');
      setTasks(data || []);
    } catch (error) {
      console.error('Failed to refresh tasks:', error);
    }
  };

  const loadUsers = async () => {
    try {
      const data = await invoke('getProjectUsers');
      setUsers(data || []);
    } catch (e) {
      console.error('Failed to load users:', e);
    }
  };

  // Sync tasks from Flask backend
  const handleSyncFromBackend = async () => {
    setSyncing(true);
    setSyncStatus(null);
    try {
      const result = await invoke('syncFromBackend');
      if (result.success) {
        setSyncStatus({ type: 'success', message: `Synced! Added ${result.added} new task(s).` });
        await refreshTasks();
      } else {
        setSyncStatus({ type: 'error', message: result.error || 'Sync failed' });
      }
    } catch (error) {
      console.error('Sync failed:', error);
      setSyncStatus({ type: 'error', message: 'Could not connect to backend' });
    }
    setSyncing(false);
    // Clear status after 3 seconds
    setTimeout(() => setSyncStatus(null), 3000);
  };

  const handleSendToJira = async (taskId, assigneeId = null) => {
    setActionLoading(prev => ({ ...prev, [taskId]: 'sending' }));
    try {
      const result = await invoke('sendToJira', { taskId, assigneeId });
      if (result.success) {
        // Also mark as sent on Flask backend (fire and forget)
        invoke('markSentOnBackend', { taskId }).catch(() => {});
        refreshTasks();
      } else {
        alert('Failed: ' + (result.error || 'Unknown error'));
      }
    } catch (error) {
      console.error('Failed to send to Jira:', error);
    }
    setActionLoading(prev => ({ ...prev, [taskId]: null }));
    setShowAssignModal(null);
  };

  const handleDecline = async (taskId) => {
    setActionLoading(prev => ({ ...prev, [taskId]: 'declining' }));
    try {
      await invoke('declineTask', { taskId });
      // Also delete from Flask backend (fire and forget)
      invoke('deleteFromBackend', { taskId }).catch(() => {});
      refreshTasks();
    } catch (error) {
      console.error('Failed to decline task:', error);
    }
    setActionLoading(prev => ({ ...prev, [taskId]: null }));
  };

  const handleRestore = async (taskId) => {
    setActionLoading(prev => ({ ...prev, [taskId]: 'restoring' }));
    try {
      await invoke('restoreTask', { taskId });
      refreshTasks();
    } catch (error) {
      console.error('Failed to restore task:', error);
    }
    setActionLoading(prev => ({ ...prev, [taskId]: null }));
  };

  const handleDelete = async (taskId) => {
    setActionLoading(prev => ({ ...prev, [taskId]: 'deleting' }));
    try {
      await invoke('deleteTask', { taskId });
      refreshTasks();
    } catch (error) {
      console.error('Failed to delete task:', error);
    }
    setActionLoading(prev => ({ ...prev, [taskId]: null }));
  };

  const handleClearAll = async () => {
    if (window.confirm('Clear all tasks? This cannot be undone.')) {
      await invoke('clearTasks');
      refreshTasks();
    }
  };

  const filteredTasks = tasks.filter(task => {
    if (filter === 'all') return task.status !== 'declined';
    if (filter === 'pending') return task.status === 'pending';
    if (filter === 'sent') return task.status === 'sent';
    if (filter === 'declined') return task.status === 'declined';
    return true;
  });

  const pendingCount = tasks.filter(t => t.status === 'pending').length;
  const sentCount = tasks.filter(t => t.status === 'sent').length;
  const declinedCount = tasks.filter(t => t.status === 'declined').length;

  const isOverdue = (deadline) => {
    if (!deadline) return false;
    return new Date(deadline) < new Date();
  };

  const getPriorityColor = (priority) => {
    const colors = { highest: '#FF5630', high: '#FF7452', medium: '#FFAB00', low: '#36B37E' };
    return colors[priority] || colors.medium;
  };

  if (loading) {
    return <div className="app"><div className="loading">Loading tasks...</div></div>;
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <div className="logo">
            <svg width="32" height="32" viewBox="0 0 48 48" fill="none">
              <defs>
                <linearGradient id="grad1" x1="0%" y1="100%" x2="100%" y2="0%">
                  <stop offset="0%" style={{stopColor:'#6B8DD6'}}/>
                  <stop offset="50%" style={{stopColor:'#8E6DD6'}}/>
                  <stop offset="100%" style={{stopColor:'#F97B5C'}}/>
                </linearGradient>
                <linearGradient id="grad2" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" style={{stopColor:'#F9A85C'}}/>
                  <stop offset="100%" style={{stopColor:'#F97B5C'}}/>
                </linearGradient>
              </defs>
              <path d="M8 26C8 26 14 19 16 21C18 23 20 28 20 28C20 28 30 11 38 8" stroke="url(#grad1)" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
              <circle cx="38" cy="8" r="5" fill="url(#grad2)"/>
            </svg>
            <h1>DoNotMiss</h1>
          </div>
          <span className="subtitle">AI-Powered Task Capture</span>
        </div>
        <div className="header-right">
          <div className="stats">
            <div className="stat"><span className="stat-value">{pendingCount}</span><span className="stat-label">Inbox</span></div>
            <div className="stat stat-done"><span className="stat-value">{sentCount}</span><span className="stat-label">Sent</span></div>
          </div>
          <button 
            className={`btn btn-sync ${syncing ? 'syncing' : ''}`} 
            onClick={handleSyncFromBackend} 
            disabled={syncing}
            title="Sync tasks from Flask backend"
          >
            {syncing ? '🔄' : '⬇️'} Sync
          </button>
          <button className="btn btn-text" onClick={handleClearAll} title="Clear all tasks">🗑️</button>
        </div>
      </header>

      {syncStatus && (
        <div className={`sync-status ${syncStatus.type}`}>
          {syncStatus.type === 'success' ? '✅' : '❌'} {syncStatus.message}
        </div>
      )}

      <div className="filters">
        <button className={`filter-btn ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
          All ({tasks.filter(t => t.status !== 'declined').length})
        </button>
        <button className={`filter-btn ${filter === 'pending' ? 'active' : ''}`} onClick={() => setFilter('pending')}>
          ⏳ Inbox ({pendingCount})
        </button>
        <button className={`filter-btn ${filter === 'sent' ? 'active' : ''}`} onClick={() => setFilter('sent')}>
          ✅ Sent ({sentCount})
        </button>
        <button className={`filter-btn declined ${filter === 'declined' ? 'active' : ''}`} onClick={() => setFilter('declined')}>
          🗑️ Declined ({declinedCount})
        </button>
      </div>

      <div className="task-list">
        {filteredTasks.length === 0 ? (
          <div className="empty-state">
            <p>No tasks found</p>
            <span>Capture tasks from anywhere using the DoNotMiss extension</span>
          </div>
        ) : (
          filteredTasks.map(task => (
            <div key={task.id} className={`task-card ${task.status}`}>
              <div className="task-header">
                <div className="task-badges">
                  <span className={`source-badge ${task.source}`}>
                    {task.source === 'email' && '📧'}{task.source === 'chat' && '💬'}{task.source === 'web' && '🌐'} {task.source}
                  </span>
                  <span className="priority-badge" style={{ background: getPriorityColor(task.priority) }}>
                    {task.priority}
                  </span>
                </div>
                {task.status === 'sent' && (
                  <span className="status-sent">✅ In Jira</span>
                )}
                {task.status === 'declined' && (
                  <span className="status-declined">🗑️ Declined</span>
                )}
              </div>
              
              <h3 className="task-title">{task.title}</h3>
              
              {task.description && task.description !== task.title && (
                <p className="task-description">{task.description}</p>
              )}

              <div className="task-meta">
                {task.deadline && (
                  <span className={`due-date ${isOverdue(task.deadline) ? 'overdue' : ''}`}>
                    📅 {isOverdue(task.deadline) ? '⚠️ ' : ''}Due: {new Date(task.deadline).toLocaleDateString()}
                  </span>
                )}
                {task.jiraKey && (
                  <button onClick={() => openIssue(task.jiraKey)} className="jira-key-btn">
                    🎫 {task.jiraKey}
                  </button>
                )}
              </div>
              
              <div className="task-footer">
                <span className="task-time">{new Date(task.createdAt).toLocaleString()}</span>
                
                <div className="task-actions">
                  {task.status === 'pending' && (
                    <>
                      <button className="btn btn-secondary" onClick={() => handleDecline(task.id)} disabled={actionLoading[task.id]}>
                        {actionLoading[task.id] === 'declining' ? '...' : 'Decline'}
                      </button>
                      <button className="btn btn-primary" onClick={() => setShowAssignModal(task.id)} disabled={actionLoading[task.id]}>
                        {actionLoading[task.id] === 'sending' ? 'Creating...' : 'Send to Jira'}
                      </button>
                    </>
                  )}
                  
                  {task.status === 'sent' && (
                    <button onClick={() => openIssue(task.jiraKey)} className="btn btn-primary">
                      Open {task.jiraKey} →
                    </button>
                  )}

                  {task.status === 'declined' && (
                    <>
                      <button className="btn btn-secondary" onClick={() => handleDelete(task.id)} disabled={actionLoading[task.id]}>
                        {actionLoading[task.id] === 'deleting' ? '...' : 'Delete'}
                      </button>
                      <button className="btn btn-primary" onClick={() => handleRestore(task.id)} disabled={actionLoading[task.id]}>
                        {actionLoading[task.id] === 'restoring' ? '...' : 'Restore'}
                      </button>
                    </>
                  )}
                </div>
              </div>

              {showAssignModal === task.id && (
                <div className="assign-modal">
                  <div className="assign-header">
                    <span>Assign & Create Issue</span>
                    <button onClick={() => setShowAssignModal(null)}>×</button>
                  </div>
                  <div className="assign-options">
                    <button className="assign-option" onClick={() => handleSendToJira(task.id)}>
                      <span>👤</span> Unassigned
                    </button>
                    {users.map(user => (
                      <button key={user.accountId} className="assign-option" onClick={() => handleSendToJira(task.id, user.accountId)}>
                        {user.avatar && <img src={user.avatar} alt="" className="avatar" />}
                        {user.displayName}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default App;
