import { renderAgentDetailPage } from './render/agent-detail-page.js';
import { renderAlertsPage } from './render/alerts-page.js';
import { renderConfigPage } from './render/config-page.js';
import { renderProjectSidesPage } from './render/project-sides-page.js';
import { renderMonitorPage } from './render/monitor-page.js';
import { renderPoolPage } from './render/pool-page.js';
import { renderProjectsPage } from './render/projects-page.js';
import { renderTasksPage } from './render/tasks-page.js';

const AGENT_NAME_RE = /^[\w\-]+$/;

export function installDashboardPageRoutes(app, { idleThreshold, idleThresholdSec }) {
  app.get('/alerts', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('html').send(renderAlertsPage());
  });

  app.get('/config', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('html').send(renderConfigPage());
  });

  app.get('/project-sides', (_req, res) => {
    res.type('html').send(renderProjectSidesPage());
  });

  app.get('/', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('html').send(renderMonitorPage({ idleThreshold, idleThresholdSec }));
  });

  app.get('/agents/:name', (req, res) => {
    const name = req.params.name;
    if (!AGENT_NAME_RE.test(name)) return res.status(400).type('text').send('invalid agent name');
    res.set('Cache-Control', 'no-store');
    return res.type('html').send(renderAgentDetailPage(name));
  });

  app.get('/agents/:name/audit', (req, res) => {
    const name = req.params.name;
    if (!AGENT_NAME_RE.test(name)) return res.status(400).type('text').send('invalid agent name');
    const target = `/agents/${encodeURIComponent(name)}#audit`;
    return res.redirect(302, target);
  });

  app.get('/tasks', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('html').send(renderTasksPage());
  });

  app.get('/projects', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('html').send(renderProjectsPage());
  });

  app.get('/pool', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('html').send(renderPoolPage());
  });
}
