import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { installDashboardPageRoutes } from '../lib/dashboard/page-routes.js';
import { installProjectBoardProxyRoutes } from '../lib/dashboard/proxy-routes.js';
import { renderMonitorPage } from '../lib/dashboard/render/monitor-page.js';
import { renderProjectsPage } from '../lib/dashboard/render/projects-page.js';

describe('project board Dashboard', () => {
  it('project_page_renders_board_surfaces', async () => {
    const html = renderProjectsPage();

    for (const marker of [
      'id="project-select"',
      'id="metrics"',
      'id="agents"',
      'id="resources"',
      'id="artifacts"',
      'id="task-board"',
      'id="graphs"',
      'id="changes"',
      'id="activity"',
    ]) {
      expect(html).toContain(marker);
    }
    expect(html).toContain('Repositories &amp; worktrees');
    expect(html).toContain('Specs &amp; issues');
    expect(html).toContain('provider-neutral');

    const app = express();
    installDashboardPageRoutes(app, { idleThreshold: 20_000, idleThresholdSec: 20 });
    const response = await request(app).get('/projects').expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.text).toContain('PROJECT BOARD');
  });

  it('project_page_coalesces_refresh', () => {
    const html = renderProjectsPage();

    expect(html).toContain('if(refreshInFlight){refreshQueued=true;return}');
    expect(html).toContain("if(refreshQueued){refreshQueued=false;refresh()}");
  });

  it('project_agents_link_to_the_monitor_and_monitor_has_complete_navigation', () => {
    const projectsHtml = renderProjectsPage();
    const monitorHtml = renderMonitorPage({ idleThreshold: 20_000, idleThresholdSec: 20 });

    expect(projectsHtml).toContain('href="/?agent=');
    expect(projectsHtml).toContain('aria-label="Monitor ');
    expect(monitorHtml).toContain('<a class="active" aria-current="page" href="/">MONITOR</a>');
    for (const href of ['/projects', '/tasks', '/pool', '/alerts', '/config']) {
      expect(monitorHtml).toContain(`href="${href}"`);
    }
    expect(monitorHtml).toContain("new URLSearchParams(window.location.search).get('agent')");
    expect(monitorHtml).toContain('if (requestedAgent) selectAgent(requestedAgent)');
  });

  it('project_board_proxy_is_read_only', async () => {
    const backendFetch = vi.fn(async url => ({
      status: 200,
      async json() {
        return { projects: [], observedUrl: String(url) };
      },
    }));
    const app = express();
    app.use(express.json());
    installProjectBoardProxyRoutes(app, {
      backendBaseUrl: 'http://127.0.0.1:8090',
      backendFetch,
    });

    const response = await request(app).get('/api/project-board?activity_limit=17').expect(200);
    expect(backendFetch).toHaveBeenCalledTimes(1);
    expect(backendFetch.mock.calls[0][0]).toBeInstanceOf(URL);
    expect(backendFetch.mock.calls[0][0].toString()).toBe(
      'http://127.0.0.1:8090/api/project-board?activity_limit=17',
    );
    expect(response.body.projects).toEqual([]);
    await request(app).post('/api/project-board').send({ mutate: true }).expect(404);
  });
});
