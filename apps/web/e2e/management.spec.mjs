/**
 * @file apps/web/e2e/management.spec.mjs
 *
 * Comprehensive E2E Playwright test suite for Glassbox Web Management UI.
 * Verifies:
 * - Visible navigation across all 11 management pages
 * - Desktop and mobile drawer navigation with focus management and touch targets
 * - Real browser interactions (DetailRail open/close, Escape key, Accept/Rework actions)
 * - MasterDetail inspection for Runs and Conversations
 * - List searching, status/channel filtering, empty states, and truthful absent states
 * - Trace 3-column layout, scale tiers (28, 100, 500, >500 events), keyboard navigation (j/k/e//), and large Raw Trace payload
 * - Decision Tester interactive simulation (ALLOW, REQUIRES_APPROVAL, DENY) without persisting
 * - Settings controls with truthful local draft semantics
 * - Fail-closed authentication gating, visible loading state, and page data error check in live mode
 * - Zero page-level horizontal overflow across 5 viewports:
 *   1440x900, 1024x768, 768x1024, 390x844, 320x700
 * - Content resilience: long Chinese titles, long IDs, paths, disconnected and stale states, unknown quota
 * - Zero unexpected console or page errors across all tests
 * - Visual evidence screenshots for the 6 canonical views
 */
import { test, expect } from '@playwright/test';

const PAGES = [
  { id: 'overview', titleZh: '概览', titleEn: 'Overview', heading: '概览' },
  { id: 'conversations', titleZh: '会话', titleEn: 'Conversations', heading: '会话' },
  { id: 'ops', titleZh: '任务协作', titleEn: 'Task Collaboration', heading: '任务协作' },
  { id: 'identity', titleZh: '身份与访问', titleEn: 'Identity & Access', heading: '身份与访问' },
  { id: 'runs', titleZh: '运行记录', titleEn: 'Runs', heading: '运行记录' },
  { id: 'trace', titleZh: '追踪', titleEn: 'Trace', heading: '追踪' },
  { id: 'pi', titleZh: 'PI', titleEn: 'PI Engine', heading: 'PI' },
  { id: 'channels', titleZh: '渠道与集成', titleEn: 'Channels & Integrations', heading: '渠道与集成' },
  { id: 'permissions', titleZh: '权限', titleEn: 'Permissions', heading: '权限控制面' },
  { id: 'monitor', titleZh: '监控', titleEn: 'Monitor', heading: '系统监控' },
  { id: 'settings', titleZh: '设置', titleEn: 'Settings', heading: '系统设置' },
];

const VIEWPORTS = [
  { width: 1440, height: 900, name: 'Desktop (1440x900)' },
  { width: 1024, height: 768, name: 'Laptop (1024x768)' },
  { width: 768, height: 1024, name: 'Tablet (768x1024)' },
  { width: 390, height: 844, name: 'Mobile (390x844)' },
  { width: 320, height: 700, name: 'Narrow Mobile (320x700)' },
];

test.describe('Web Management Frozen Specification E2E Suite', () => {
  let capturedErrors = [];

  // Enforce zero unexpected console or page errors across EVERY test
  test.beforeEach(({ page }) => {
    capturedErrors = [];
    page.on('console', (msg) => {
      if (
        msg.type() === 'error' &&
        !msg.text().includes('favicon.ico') &&
        !msg.text().includes('404')
      ) {
        capturedErrors.push(`[console.error] ${msg.text()}`);
      }
    });
    page.on('pageerror', (err) => {
      capturedErrors.push(`[pageerror] ${err.message}`);
    });
  });

  test.afterEach(() => {
    expect(
      capturedErrors,
      `Unexpected console or page errors encountered:\n${capturedErrors.join('\n')}`,
    ).toHaveLength(0);
  });

  // 1. Full 11-page desktop navigation via visible sidebar controls
  test('navigates all 11 management pages through visible navigation controls with zero console errors', async ({
    page,
  }) => {
    await page.goto('/manage?page=overview');
    await expect(page.locator('h1')).toContainText('概览');
    await expect(page.locator('#crumb')).toContainText('概览 (Overview)');

    for (const p of PAGES) {
      const navItem = page.locator(`.sidebarNav button.navItem:has-text("${p.titleZh}")`);
      await expect(navItem).toBeVisible();
      await navItem.click();

      await expect(page).toHaveURL(new RegExp(`page=${p.id}`));
      await expect(page.locator('h1')).toContainText(p.heading);
      await expect(page.locator('#crumb')).toContainText(`${p.titleZh} (${p.titleEn})`);
      await expect(navItem).toHaveClass(/active/);
      await expect(navItem).toHaveAttribute('aria-current', 'page');
    }
  });

  // 2. Mobile drawer menu, navigation, touch targets, and dismissals across mobile viewports
  test('supports mobile drawer toggle, navigation, touch targets, and dismissals across mobile viewports', async ({
    page,
  }) => {
    // Test at 390x844
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/manage?page=overview');

    // Desktop sidebar must be hidden on mobile
    await expect(page.locator('.sidebarNav')).toBeHidden();

    // Mobile menu button must be visible with >=44px touch target
    const menuBtn = page.locator('.mobileMenuBtn');
    await expect(menuBtn).toBeVisible();
    const box = await menuBtn.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);

    const drawer = page.locator('.mobileDrawer');
    const waitForDrawerSettled = async () => {
      await expect(drawer).toHaveClass(/open/);
      await expect.poll(async () => {
        const b = await drawer.boundingBox();
        if (!b) return false;
        return Math.abs(b.x) <= 1 && b.width >= 240;
      }, { message: 'Waiting for mobile drawer slide-in transition to settle' }).toBe(true);
    };

    // Open drawer
    await menuBtn.click();
    await waitForDrawerSettled();

    // Dismiss via Escape key
    await page.keyboard.press('Escape');
    await expect(drawer).not.toHaveClass(/open/);

    // Open and dismiss via Close Button
    await menuBtn.click();
    await waitForDrawerSettled();
    const closeBtn = page.locator('.drawerCloseBtn');
    await expect(closeBtn).toBeVisible();
    await closeBtn.click();
    await expect(drawer).not.toHaveClass(/open/);

    // Open and dismiss via Backdrop Overlay click
    await menuBtn.click();
    await waitForDrawerSettled();
    await page.locator('.mobileDrawerOverlay').click({ position: { x: 350, y: 100 } });
    await expect(drawer).not.toHaveClass(/open/);

    // Navigate to Ops via drawer item
    await menuBtn.click();
    await waitForDrawerSettled();
    const opsDrawerBtn = drawer.locator('button.navItem:has-text("任务协作")');
    await opsDrawerBtn.click();
    await expect(drawer).not.toHaveClass(/open/);
    await expect(page).toHaveURL(/page=ops/);
    await expect(page.locator('h1')).toContainText('任务协作');

    // Navigate to Settings via drawer item
    await menuBtn.click();
    await waitForDrawerSettled();
    const settingsDrawerBtn = drawer.locator('button.navItem:has-text("设置")');
    await settingsDrawerBtn.click();
    await expect(drawer).not.toHaveClass(/open/);
    await expect(page).toHaveURL(/page=settings/);
    await expect(page.locator('h1')).toContainText('系统设置');

    // Test at 320x700 narrow mobile
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto('/manage?page=overview');
    await expect(page.locator('.mobileMenuBtn')).toBeVisible();
    await page.locator('.mobileMenuBtn').click();
    await waitForDrawerSettled();
    await page.keyboard.press('Escape');
    await expect(drawer).not.toHaveClass(/open/);
  });

  // 3. Task Collaboration (Ops) DetailRail inspection, keyboard escape, close button, and Accept/Rework actions
  test('supports Task Collaboration (Ops) DetailRail inspection, keyboard escape, close button, and Accept/Rework actions', async ({
    page,
  }) => {
    await page.goto('/manage?page=ops');
    await expect(page.locator('h1')).toContainText('任务协作');

    // Click task-218 row
    const taskRow = page.locator('tr:has-text("task-218")').first();
    await expect(taskRow).toBeVisible();
    await taskRow.click();

    // Verify DetailRail opened
    const detailRail = page.locator('.detailRail');
    await expect(detailRail).toBeVisible();
    await expect(detailRail).toContainText('task-218');
    await expect(detailRail).toContainText('REVIEW'); // Glassbox truth
    await expect(detailRail).toContainText('done'); // Herdr live fact
    await expect(detailRail).toContainText('第 #1 次尝试');
    await expect(detailRail).toContainText('第 #2 次尝试');

    // Close via close button
    const railCloseBtn = detailRail.locator('.detailRailClose');
    await railCloseBtn.click();
    await expect(detailRail).not.toBeVisible();

    // Open again and close via Escape key
    await taskRow.click();
    await expect(detailRail).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(detailRail).not.toBeVisible();

    // Open again to test Accept action
    await taskRow.click();
    await expect(detailRail).toBeVisible();
    const acceptBtn = detailRail.locator('button:has-text("接受结果 (Accept)")');
    await expect(acceptBtn).toBeVisible();
    await acceptBtn.click();

    // Verify truthful design simulation notice
    const notice = page.locator('[role="alert"]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(
      '[设计模拟] 本地模拟接受任务 [task-218] 阶段产物，未连接服务端授权与持久化。',
    );

    // DetailRail state comparison updates to DONE
    await expect(detailRail).toContainText('DONE');
    await expect(detailRail).toContainText('已完成人工验收，持久化为完成态。');

    // Dismiss notice
    const noticeDismissBtn = notice.locator('button:has-text("知道了")');
    await noticeDismissBtn.click();
    await expect(notice).not.toBeVisible();

    // Reload page to test Rework action on task-218
    await page.goto('/manage?page=ops');
    await page.locator('tr:has-text("task-218")').first().click();
    await expect(detailRail).toBeVisible();

    const reworkBtn = detailRail.locator('button:has-text("要求返工 (Rework)")');
    await expect(reworkBtn).toBeVisible();
    await reworkBtn.click();

    // Verify rework simulation notice and state change to RUNNING
    await expect(page.locator('[role="alert"]')).toContainText(
      '[设计模拟] 本地模拟发起返工指令',
    );
    await expect(page.locator('[role="alert"]')).toContainText('task-218');
    await expect(detailRail).toContainText('RUNNING');
  });

  // 4. Runs and Conversations DetailRail MasterDetail inspection and keyboard close
  test('supports Runs and Conversations MasterDetail & DetailRail with truthful values', async ({
    page,
  }) => {
    // Runs Page
    await page.goto('/manage?page=runs');
    await expect(page.locator('h1')).toContainText('运行记录');

    const runRow = page.locator('tr:has-text("run_A83")').first();
    await runRow.click();

    const detailRail = page.locator('.detailRail');
    await expect(detailRail).toBeVisible();
    await expect(detailRail).toContainText('run_A83');
    await expect(detailRail).toContainText('claude-3-5-sonnet');
    await expect(detailRail).toContainText('成本不可用'); // Truthful unpriced cost

    // Press Escape to close DetailRail
    await page.keyboard.press('Escape');
    await expect(detailRail).not.toBeVisible();

    // Conversations Page
    await page.goto('/manage?page=conversations');
    await expect(page.locator('h1')).toContainText('会话');

    const convRow = page.locator('tr:has-text("conv_owner_main")').first();
    await convRow.click();

    await expect(detailRail).toBeVisible();
    await expect(detailRail).toContainText('conv_owner_main');
    await expect(detailRail).toContainText('owner_primary');

    // Close via close button
    await detailRail.locator('.detailRailClose').click();
    await expect(detailRail).not.toBeVisible();
  });

  // 5. List searching, status/channel filtering, empty states, and truthful absent states
  test('supports list searching, status/channel filtering, empty states, and truthful absent states', async ({
    page,
  }) => {
    // 1. Ops Page Filtering
    await page.goto('/manage?page=ops');
    const searchInput = page.locator('.filterBar input.filterInput');

    // Search for single task
    await searchInput.fill('task-218');
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.locator('tbody tr')).toContainText('task-218');
    await expect(page.locator('.filterCount')).toHaveText('共 1 项');

    // Search non-existent query to verify empty state
    await searchInput.fill('nonexistent_task_query_xyz');
    await expect(page.locator('tbody tr')).toHaveCount(0);
    await expect(page.locator('.tableContainer')).toContainText('暂无数据');
    await expect(page.locator('.filterCount')).toHaveText('共 0 项');

    // Clear search
    await searchInput.fill('');
    await expect(page.locator('tbody tr')).toHaveCount(4);

    // State filter: select WAITING_INPUT
    const stateSelect = page.locator('.filterBar select.filterSelect');
    await stateSelect.selectOption('WAITING_INPUT');
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.locator('tbody tr')).toContainText('task-221');

    // Reset filter
    await stateSelect.selectOption('all');
    await expect(page.locator('tbody tr')).toHaveCount(4);

    // Truthful missing workerBinding check on task-224 (0 attempts, no synthesized worker pane)
    const task224Row = page.locator('tr:has-text("task-224")').first();
    await task224Row.click();
    const detailRail = page.locator('.detailRail');
    await expect(detailRail).toContainText('task-224');
    await expect(detailRail).toContainText('尚无执行尝试记录');

    // 2. Runs Page Filtering
    await page.goto('/manage?page=runs');
    const runsSearch = page.locator('.filterBar input.filterInput');
    await runsSearch.fill('A81');
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.locator('tbody tr')).toContainText('run_A81');

    await runsSearch.fill('no_such_run_404');
    await expect(page.locator('tbody tr')).toHaveCount(0);
    await expect(page.locator('.tableContainer')).toContainText('暂无数据');

    // 3. Conversations Page Filtering (Testing unique term, empty state, and channel dropdown)
    await page.goto('/manage?page=conversations');
    const convSearch = page.locator('.filterBar input.filterInput');

    // Search unique term for one exact conversation
    await convSearch.fill('私聊');
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.locator('tbody tr')).toContainText('conv_qq_private_owner');

    // Search non-existent query to verify empty state
    await convSearch.fill('no_match_conv_xyz');
    await expect(page.locator('tbody tr')).toHaveCount(0);
    await expect(page.locator('.tableContainer')).toContainText('暂无数据');

    // Clear search and test channel dropdown filter (onebot_qq matches 2 conversations)
    await convSearch.fill('');
    const channelSelect = page.locator('.filterBar select.filterSelect');
    await channelSelect.selectOption('onebot_qq');
    await expect(page.locator('tbody tr')).toHaveCount(2);
    await expect(page.locator('tr:has-text("conv_qq_private_owner")')).toBeVisible();
    await expect(page.locator('tr:has-text("conv_qq_group_test")')).toBeVisible();

    // Refine search within filtered channel to isolate group conversation
    await convSearch.fill('conv_qq_group_test');
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.locator('tbody tr')).toContainText('conv_qq_group_test');

    // 4. Overview Page Truthful Unpriced Costs (Never fabricated as $0.00)
    await page.goto('/manage?page=overview');
    await expect(page.locator('.summaryBar')).toContainText('成本不可用 (未配置计价模型)');
    await expect(page.locator('.summaryBar')).not.toContainText('$0.00');

    const modelTable = page.locator('table.dataTable');
    await expect(modelTable).toContainText('成本不可用');
  });

  // 6. Trace 3-column layout, scale tiers (28, 100, 500, >500), filtering, search, selection, and keyboard navigation
  test('supports Trace 3-column layout, scale tiers (28, 100, 500, >500), filtering, search, selection, and keyboard navigation', async ({
    page,
  }) => {
    await page.goto('/manage?page=trace');
    await expect(page.locator('h1')).toContainText('追踪');

    // Verify 3 columns exist
    await expect(page.locator('.traceRunList')).toBeVisible();
    await expect(page.locator('.traceTimeline')).toBeVisible();
    await expect(page.locator('.traceInspector')).toBeVisible();

    // Scale Tier 1: 28 events (run_A79)
    await page.locator('.traceRunItem:has-text("run_A79")').click();
    await expect(page.locator('.timelineScrubber')).toContainText('28 / 28');
    await expect(page.locator('.timelineEventItem')).toHaveCount(28);

    // Scale Tier 2: 100 events (run_A81)
    await page.locator('.traceRunItem:has-text("run_A81")').click();
    await expect(page.locator('.timelineScrubber')).toContainText('100 / 100');
    await expect(page.locator('.timelineEventItem')).toHaveCount(100);

    // Scale Tier 3: 500 events (run_A83) - Proving search, type filter, list count match, and selection
    await page.locator('.traceRunItem:has-text("run_A83")').click();
    await expect(page.locator('.timelineScrubber')).toContainText('500 / 500');
    await expect(page.locator('.timelineEventItem')).toHaveCount(500);

    // Search within 500 events: reduce visible count
    const traceSearch = page.locator('.timelineScrubber input[type="search"]');
    await traceSearch.fill('authorization');
    const scrubberMatch = (await page.locator('.timelineCount').textContent()).match(/(\d+) \/ 500/);
    expect(scrubberMatch).not.toBeNull();
    const authFilteredCount = parseInt(scrubberMatch[1], 10);
    // The generator cycles 14 event types, so 500 events yield exactly 36 'authorization' events.
    expect(authFilteredCount).toBe(36);
    // Assert list count matches the displayed scrubber count
    await expect(page.locator('.timelineEventItem')).toHaveCount(authFilteredCount);

    // Type filter: select tool
    const typeSelect = page.locator('.timelineScrubber select.filterSelect');
    await traceSearch.fill('');
    await typeSelect.selectOption('tool');
    const toolMatch = (await page.locator('.timelineCount').textContent()).match(/(\d+) \/ 500/);
    expect(toolMatch).not.toBeNull();
    const toolFilteredCount = parseInt(toolMatch[1], 10);
    expect(toolFilteredCount).toBe(36);
    await expect(page.locator('.timelineEventItem')).toHaveCount(toolFilteredCount);

    // Select second event in the filtered list and verify Inspector updates
    const secondFilteredItem = page.locator('.timelineEventItem').nth(1);
    await secondFilteredItem.click();
    await expect(secondFilteredItem).toHaveClass(/active/);
    const selectedSeqText = await secondFilteredItem.locator('.mono').first().textContent();
    const selectedSeqNum = selectedSeqText.replace('#', '').trim();
    await expect(page.locator('.inspectorContent')).toContainText(`#${selectedSeqNum}`);

    // Reset filters
    await typeSelect.selectOption('all');
    await expect(page.locator('.timelineScrubber')).toContainText('500 / 500');

    // Run list usability: switch to another run and return to 500-event run
    await page.locator('.traceRunItem:has-text("run_A79")').click();
    await expect(page.locator('.timelineScrubber')).toContainText('28 / 28');
    await expect(page.locator('.timelineEventItem')).toHaveCount(28);

    await page.locator('.traceRunItem:has-text("run_A83")').click();
    await expect(page.locator('.timelineScrubber')).toContainText('500 / 500');
    await expect(page.locator('.timelineEventItem')).toHaveCount(500);

    // Scale Tier 4: Stress Tier (>500 events, 650 events - run_A70)
    await page.locator('.traceRunItem:has-text("run_A70")').click();
    await expect(page.locator('.traceRunItem.active')).toContainText('run_A70');
    await expect(page.locator('.timelineScrubber')).toContainText('650 / 650');
    await expect(page.locator('.timelineEventItem')).toHaveCount(650);

    // Large Raw Trace Payload Inspection (Event 1 on run_A83)
    await page.locator('.traceRunItem:has-text("run_A83")').click();
    await page.locator('.timelineEventItem').first().click();

    // Frozen Inspector contract: Summary / Usage / Raw
    await page.getByRole('tab', { name: '摘要' }).click();
    await expect(page.locator('.inspectorContent')).toContainText('Conversation');
    await expect(page.locator('.inspectorContent')).toContainText('Run');
    await expect(page.locator('.inspectorContent')).toContainText('Principal');

    await page.getByRole('tab', { name: '用量' }).click();
    await expect(page.locator('.inspectorContent')).toContainText('Total Token');
    await expect(page.locator('.inspectorContent')).toContainText('成本不可用');

    // Large Raw Trace tab: verify raw append-only evidence and multiline buffer display
    await page.getByRole('tab', { name: '原始' }).click();
    await expect(page.locator('.inspectorContent')).toContainText('// 按需装载的不可变追加原始证据 (Raw Trace)');
    await expect(page.locator('.inspectorContent')).toContainText('large_raw_trace_payload');
    await expect(page.locator('.inspectorContent')).toContainText('raw_append_only_event_log');
    await expect(page.locator('.inspectorContent')).toContainText('terminalOutputBuffer');
    const inspectorText = (await page.locator('.inspectorContent').textContent()) || '';
    expect(inspectorText.length).toBeGreaterThanOrEqual(16384);

    await page.getByRole('tab', { name: '摘要' }).click();

    // Real scrubber, jump-latest, copy and export controls are present and operable.
    const eventScrubber = page.getByRole('slider', { name: '追踪事件 Scrubber' });
    await eventScrubber.fill('500');
    await expect(page.locator('.timelineEventItem.active')).toContainText('#500');
    await page.getByRole('button', { name: '跳到最新' }).click();
    await expect(page.locator('.timelineEventItem.active')).toContainText('#500');
    await expect(page.getByRole('button', { name: '复制 JSON' })).toBeEnabled();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出筛选 JSON' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('run_A83-screened-events.json');

    // Keyboard Navigation: j, k, e, /
    const firstEvent = page.locator('.timelineEventItem').first();
    await firstEvent.click();
    await expect(firstEvent).toHaveClass(/active/);

    // Press 'j' -> moves down to event #2
    await page.keyboard.press('j');
    const secondEvent = page.locator('.timelineEventItem').nth(1);
    await expect(secondEvent).toHaveClass(/active/);

    // Press 'k' -> moves back up to event #1
    await page.keyboard.press('k');
    await expect(firstEvent).toHaveClass(/active/);

    // Press 'e' -> expands the selected event inline
    await page.keyboard.press('e');
    await expect(firstEvent).toHaveAttribute('aria-expanded', 'true');
    await expect(firstEvent.locator('.timelineEventExpanded')).toBeVisible();

    // Press 'e' again -> collapses the selected event
    await page.keyboard.press('e');
    await expect(firstEvent).toHaveAttribute('aria-expanded', 'false');
    await expect(firstEvent.locator('.timelineEventExpanded')).toHaveCount(0);

    // Press '/' -> focuses search input
    await page.keyboard.press('/');
    await expect(traceSearch).toBeFocused();
  });

  // 7. Decision Tester interactive simulation without persisting production decisions
  test('interactively tests Decision Tester and outputs ALLOW / REQUIRES_APPROVAL / DENY with simulation disclaimer', async ({
    page,
  }) => {
    await page.goto('/manage?page=permissions');
    await expect(page.locator('h1')).toContainText('权限控制面');

    // Verify Four Hard Gates display
    await expect(page.locator('.summaryItem:has-text("Ingress Gate")')).toBeVisible();
    await expect(page.locator('.summaryItem:has-text("Context Gate")')).toBeVisible();
    await expect(page.locator('.summaryItem:has-text("Tool / Ops Gate")')).toBeVisible();
    await expect(page.locator('.summaryItem:has-text("Delivery Gate")')).toBeVisible();

    const evalBtn = page.locator('button:has-text("执行裁决模拟计算")');
    await expect(evalBtn).toBeVisible();

    // 1. Trigger simulation with default destructive action (clean_reset)
    await evalBtn.click();
    await expect(page.locator('.detailRail')).toContainText('REQUIRES_APPROVAL');
    await expect(page.locator('.detailRail')).toContainText('gate-02');
    await expect(page.locator('.detailRail')).toContainText(
      '[设计模拟] 本结果仅基于前端内置策略矩阵离线推演，不代表服务端实时授权决策，未向服务端持久化任何授权判定记录。',
    );

    // 2. Change input to normal git read/write -> ALLOW
    await page.locator('#test-resource').fill('workspace:git');
    await page.locator('#test-action').fill('commit');
    await evalBtn.click();
    await expect(page.locator('.detailRail')).toContainText('ALLOW');
    await expect(page.locator('.detailRail')).toContainText('rule-101');

    // 3. Change input to visitor unauthorized secret read -> DENY
    await page.locator('#test-principal').fill('visitor_guest');
    await page.locator('#test-resource').fill('admin:secrets');
    await page.locator('#test-action').fill('read');
    await evalBtn.click();
    await expect(page.locator('.detailRail')).toContainText('DENY');
    await expect(page.locator('.detailRail')).toContainText('gate-01');
  });

  // 8. Settings form controls, local draft dirty tracking, save notice, and reset to defaults
  test('supports Settings form controls, local draft dirty tracking, save notice, and reset to defaults', async ({
    page,
  }) => {
    await page.goto('/manage?page=settings');
    await expect(page.locator('h1')).toContainText('系统设置');

    const saveBtn = page.locator('button:has-text("保存设置草稿")');
    const resetBtn = page.locator('button:has-text("恢复默认设置")');

    // Initially save button is disabled, reset button is visible
    await expect(saveBtn).toBeDisabled();
    await expect(resetBtn).toBeVisible();

    // Toggle color blind mode checkbox
    const colorBlindToggle = page.locator('input[type="checkbox"]').first();
    await colorBlindToggle.click();

    // Save button becomes enabled
    await expect(saveBtn).toBeEnabled();
    await expect(resetBtn).toBeVisible();

    // Click Save Draft
    await saveBtn.click();

    // Feedback notice appears
    const notice = page.locator('[role="alert"]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(
      '[本地设计草稿] 设置已保存在浏览器临时会话中，未持久化至服务端配置。',
    );
    await expect(saveBtn).toBeDisabled();

    // Dismiss notice
    await notice.locator('button:has-text("确定")').click();
    await expect(notice).not.toBeVisible();

    // Modify retention days and test Reset to Defaults
    const retentionInput = page.locator('input[type="number"]');
    await retentionInput.fill('60');
    await expect(saveBtn).toBeEnabled();

    await resetBtn.click();
    await expect(retentionInput).toHaveValue('30');
    await expect(page.locator('[role="alert"]')).toContainText(
      '[本地设计草稿] 已重置回初始设计配置，未连接服务端。',
    );
  });

  // 9. Live Mode fail-closed authentication gating, visible loading state, and page data error check
  test('enforces Live Mode fail-closed authentication gating, visible loading state, and page data error check', async ({
    page,
  }) => {
    // 1. Unauthenticated live mode must fail-closed: management controls hidden
    await page.goto('/manage?mode=live');
    await expect(page.locator('.sidebarNav')).not.toBeVisible();
    await expect(page.locator('h1')).not.toBeVisible();
    await expect(page.locator('h2')).toContainText('输入 Glassbox Management Token');
    await expect(page.locator('text=实时模式需要所有者凭据 (Live Mode Auth)')).toBeVisible();

    // 2. Submit invalid token format -> FAIL CLOSED alert
    const tokenInput = page.locator('#mgmt-token-input');
    await tokenInput.fill('short_invalid_token');
    await page.locator('button[type="submit"]').click();

    const alert = page.locator('[role="alert"]');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('Token 格式无效：必须为 43 位 base64url 编码字符串。');
    await expect(alert).toContainText('FAIL CLOSED');

    // 3. Test visible loading state during auth verification (deferred response)
    let resolveStatusRequest;
    const statusDeferred = new Promise((resolve) => {
      resolveStatusRequest = resolve;
    });

    await page.route('**/manage/status', async (route) => {
      await statusDeferred;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ service: 'invalid', status: 'not-ready' }),
      });
    });

    await page.locator('button:has-text("重新输入 Token")').click();
    await tokenInput.fill('abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE');
    await page.locator('button[type="submit"]').click();

    // Assert visible loading state while verification is in progress
    await expect(page.locator('text=校验所有者管理凭据中...')).toBeVisible();
    await expect(page.locator('text=正在向 /manage/status 发起 Bearer 鉴权校验，安全默认关闭')).toBeVisible();
    await expect(page.locator('.sidebarNav')).not.toBeVisible();

    // Resolve deferred request with invalid status response (fails closed without network console error)
    resolveStatusRequest();

    // Assert explicit FAIL CLOSED alert
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('FAIL CLOSED');
    await expect(alert).toContainText('服务端状态异常，非合规 Glassbox 实例');

    // 4. Test page data error check in live mode (fail-closed without falling back to fixtures)
    await page.unroute('**/manage/status');
    await page.route('**/manage/status', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          service: 'glassbox',
          version: '0.0.0',
          status: 'ready',
          platform: 'linux',
          defaultExecution: 'claude-code',
          capabilities: { modelConfiguration: true, channels: true },
        }),
      });
    });

    await page.route('**/manage/models', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ profiles: 'invalid' }),
      });
    });

    await page.route('**/manage/channels', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ channels: [] }),
      });
    });


    // Re-submit token to gain live authorization
    await page.locator('button:has-text("重新输入 Token")').click();
    await tokenInput.fill('abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE');
    await page.locator('button[type="submit"]').click();

    // Shell loads in live mode
    await expect(page.locator('.sidebarNav')).toBeVisible();
    // Scope to the topbar data-source badge: page headers also render .capabilityBadge.ok,
    // so an unscoped locator would resolve to multiple elements.
    await expect(
      page.locator('.topbar .repoMeta .capabilityBadge'),
    ).toContainText('实时接口 (/manage)');

    // Navigate to PI page where /manage/models was intercepted with invalid payload
    await page.locator('.sidebarNav button.navItem:has-text("PI")').click();
    await expect(page.locator('[role="alert"]')).toBeVisible();
    await expect(page.locator('[role="alert"]')).toContainText('模型数据加载失败');
    await expect(page.locator('[role="alert"]')).toContainText('PayloadValidationError');

    // Fail-closed verification: no fake model rows are fabricated
    const modelInventoryTable = page.locator('table.dataTable:has(th:has-text("可用配额"))');
    await expect(modelInventoryTable).not.toBeVisible();

    // 5. Switch back to design preview mode
    const switchModeBtn = page.locator('button:has-text("切至设计数据")');
    await switchModeBtn.click();
    await expect(page).toHaveURL(/mode=design/);
    await expect(page.locator('header.topbar').getByText('设计数据 (Preview)', { exact: true })).toBeVisible();
    await expect(page.locator('text=加载 PI 模型数据中...')).not.toBeVisible();
    await expect(modelInventoryTable).toBeVisible();
    await expect(modelInventoryTable).toContainText('Claude 3.5 Sonnet');
    await expect(modelInventoryTable).toContainText('未知 (未上报)');
  });

  // 10. Zero horizontal page scroll across all 5 responsive viewports
  for (const vp of VIEWPORTS) {
    test(`verifies zero horizontal page scroll across key pages at ${vp.name}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });

      const testPages = PAGES.map((item) => item.id);
      for (const pageId of testPages) {
        await page.goto(`/manage?page=${pageId}`);
        await page.waitForLoadState('domcontentloaded');

        const hasHorizontalScroll = await page.evaluate(() => {
          // Compare against clientWidth (the CSS viewport excluding the scrollbar gutter).
          // window.innerWidth includes the classic scrollbar gutter, so a small overflow
          // could otherwise read as no overflow at all.
          return (
            document.documentElement.scrollWidth > document.documentElement.clientWidth ||
            document.body.scrollWidth > document.documentElement.clientWidth
          );
        });

        expect(
          hasHorizontalScroll,
          `Horizontal page overflow detected on page "${pageId}" at ${vp.width}x${vp.height}`,
        ).toBe(false);

        const unreachable = await page.evaluate(() => {
          const viewport = document.querySelector('.mainViewport');
          const root = document.querySelector('.pageContainer');
          if (!(viewport instanceof HTMLElement) || !(root instanceof HTMLElement)) return null;
          const viewportRect = viewport.getBoundingClientRect();
          const visible = (el) => {
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
          };
          const hasReachableScrollAncestor = (el) => {
            let current = el.parentElement;
            while (current && current !== viewport) {
              const style = getComputedStyle(current);
              if ((style.overflowX === 'auto' || style.overflowX === 'scroll') && current.scrollWidth > current.clientWidth + 1) {
                return true;
              }
              current = current.parentElement;
            }
            return false;
          };
          for (const el of root.querySelectorAll('*')) {
            if (!(el instanceof HTMLElement) || !visible(el)) continue;
            const rect = el.getBoundingClientRect();
            if ((rect.right > viewportRect.right + 1 || rect.left < viewportRect.left - 1) && !hasReachableScrollAncestor(el)) {
              return {
                tag: el.tagName,
                className: el.className,
                text: (el.textContent || '').trim().slice(0, 80),
                left: Math.round(rect.left),
                right: Math.round(rect.right),
                viewportLeft: Math.round(viewportRect.left),
                viewportRight: Math.round(viewportRect.right),
              };
            }
          }
          return null;
        });
        expect(unreachable, `Unreachable clipped content on ${pageId} at ${vp.width}x${vp.height}: ${JSON.stringify(unreachable)}`).toBeNull();
      }
    });
  }

  // 11. Content resilience under extreme edge cases (long Chinese titles, long IDs, long paths, long error messages, disconnected state, unknown quota)
  test('verifies content resilience under extreme edge cases (long Chinese titles, long IDs, long paths, long error messages, disconnected state, and unknown quota) across viewports', async ({
    page,
  }) => {
    // 1. Disconnected state: Email bridge channel
    await page.goto('/manage?page=channels');
    await expect(page.locator('h1')).toContainText('渠道与集成');
    const disconnectedRow = page.locator('tr:has-text("chan_email_bridge")');
    await expect(disconnectedRow).toBeVisible();
    await expect(disconnectedRow).toContainText('未连接');

    // 2. Subsystem warnings, stale state, and long error messages (>100 chars)
    await page.goto('/manage?page=monitor');
    await expect(page.locator('h1')).toContainText('系统监控');
    const subsystemSummary = page.locator('.summaryBar').first();
    await expect(subsystemSummary).toContainText('HEALTHY');
    await expect(subsystemSummary).toContainText('STALE');
    const alertsPanel = page.locator('div:has(> h3:has-text("观测告警与审计事件"))');
    const alertMessage = alertsPanel.locator('span:has-text("DeepSeek Chat (V3)")').first();
    await expect(alertMessage).toContainText(
      'DeepSeek Chat (V3) 模型在 13:42:15 出现一次暂态超时与网络重试失败异常',
    );
    const alertText = (await alertMessage.textContent()) || '';
    expect(alertText.length).toBeGreaterThan(100);

    // 3. Long Chinese titles (>50 chars), long IDs (>40 chars), and long artifact paths (>100 chars) in Ops
    await page.goto('/manage?page=ops');
    await expect(page.locator('h1')).toContainText('任务协作');
    const longTaskRow = page.locator('tr:has-text("长期会话上下文持久化与 Turso 数据库跨架构平滑迁移验证基准测试执行计划")');
    await expect(longTaskRow).toBeVisible();

    const task215Row = page.locator('tr:has-text("task-215")').first();
    const task215IdText = (await task215Row.locator('.mono').first().textContent()) || '';
    expect(task215IdText.trim().length).toBeGreaterThan(40);

    const task215RowText = (await task215Row.textContent()) || '';
    expect(task215RowText).toContain(
      '长期会话上下文持久化与 Turso 数据库跨架构平滑迁移验证基准测试执行计划（第四阶段全量边界覆盖）',
    );

    await task215Row.click();
    const detailRail = page.locator('.detailRail');
    await expect(detailRail).toContainText(
      'r2://artifacts/glassbox/workspaces/storage/runs/task-215/benchmark-long-execution-report-with-verified-provenance-data.json',
    );
    const artifactPathText =
      (await detailRail.locator('.pairRow span.mono:has-text("r2://artifacts")').textContent()) || '';
    expect(artifactPathText.length).toBeGreaterThan(100);

    // 4. Long IDs and scoped delegation constraints in Identity
    await page.goto('/manage?page=identity');
    await expect(page.locator('h1')).toContainText('身份与访问');
    const workerRow = page.locator('tr:has-text("worker_herdr_04")');
    await expect(workerRow).toBeVisible();
    await expect(workerRow).toContainText('scoped_worktree:codex/fix-auth-cache-v2');

    // 5. Unknown quota: Pi page shows 可用配额 as 未知 (未上报), never 0 or 0%
    await page.goto('/manage?page=pi');
    await expect(page.locator('h1')).toContainText('PI 执行核心');
    const modelTable = page.locator('table.dataTable:has(th:has-text("可用配额"))');
    await expect(modelTable).toContainText('未知 (未上报)');
    await expect(modelTable).not.toContainText('0%');
    await expect(modelTable).not.toContainText('$0.00');

    // 6. Test narrow mobile viewport (320x700) to confirm content wraps without page-level horizontal overflow
    await page.setViewportSize({ width: 320, height: 700 });
    for (const testPage of ['ops', 'monitor', 'identity', 'channels', 'pi']) {
      await page.goto(`/manage?page=${testPage}`);
      await page.waitForLoadState('domcontentloaded');
      const hasHorizontalOverflow = await page.evaluate(() => {
        // clientWidth excludes the scrollbar gutter; window.innerWidth does not.
        return (
          document.documentElement.scrollWidth > document.documentElement.clientWidth ||
          document.body.scrollWidth > document.documentElement.clientWidth
        );
      });
      expect(
        hasHorizontalOverflow,
        `Horizontal overflow detected on edge-case page "${testPage}" at 320x700`,
      ).toBe(false);
    }
  });

  // 12. Visual Evidence Capture across Viewports and Core Sections
  test('captures visual evidence screenshots for audit and review', async ({ page }) => {
    // 1. Overview (1440x900)
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/manage?page=overview');
    await page.addStyleTag({ content: 'html, body, #root, .managementApp, .mainViewport { height: auto !important; min-height: 100% !important; overflow: visible !important; }' });
    await page.screenshot({ path: 'docs/ui/evidence/overview-desktop.png', fullPage: true });

    // 2. Ops with DetailRail (1440x900)
    await page.goto('/manage?page=ops');
    await page.locator('tr:has-text("task-218")').first().click();
    await expect(page.locator('.detailRail')).toBeVisible();
    await page.waitForTimeout(150);
    await page.locator('.mainViewport').evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({ path: 'docs/ui/evidence/ops-detailrail.png' });

    // 3. Trace 3-column (1440x900)
    await page.goto('/manage?page=trace');
    await expect(page.getByRole('slider', { name: '追踪事件 Scrubber' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '摘要' })).toHaveAttribute('aria-selected', 'true');
    await page.screenshot({ path: 'docs/ui/evidence/trace-inspector.png' });

    // 4. Permissions with Decision Tester (1440x900)
    await page.goto('/manage?page=permissions');
    await page.locator('button:has-text("执行裁决模拟计算")').click();
    await expect(page.locator('.detailRail')).toContainText('REQUIRES_APPROVAL');
    await page.addStyleTag({
      content:
        'html, body, #root, .managementApp, .mainViewport { height: auto !important; min-height: 100% !important; overflow: visible !important; } .detailRail { position: static !important; max-height: none !important; }',
    });
    await page.screenshot({ path: 'docs/ui/evidence/permissions-tester.png', fullPage: true });

    // 5. Mobile Drawer (390x844)
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/manage?page=overview');
    await page.locator('.mobileMenuBtn').click();
    const mobileDrawer = page.locator('.mobileDrawer');
    await expect(mobileDrawer).toHaveClass(/open/);
    await expect.poll(async () => {
      const b = await mobileDrawer.boundingBox();
      if (!b) return false;
      return Math.abs(b.x) <= 1 && b.width >= 240;
    }, { message: 'Waiting for mobile drawer slide-in transition to settle' }).toBe(true);
    await page.screenshot({ path: 'docs/ui/evidence/mobile-drawer-390x844.png' });

    // 6. Narrow Mobile (320x700)
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto('/manage?page=conversations');
    await expect(page.locator('.tableContainer')).toBeVisible();
    await page.screenshot({ path: 'docs/ui/evidence/narrow-mobile-320x700.png' });
  });

  // 13. Ops loading and error states with controlled live responses and no console errors
  test('verifies Ops loading and error states under live mode without console errors and never falls back to fixtures', async ({
    page,
  }) => {
    const validToken = 'abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE';

    await page.route('**/manage/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          service: 'glassbox',
          version: '0.0.0',
          status: 'ready',
          platform: 'linux',
          defaultExecution: 'claude-code',
          capabilities: {
            modelConfiguration: true,
            channels: true,
            conversations: true,
            runs: true,
            trace: true,
            eval: true,
          },
        }),
      });
    });

    let fulfillTasks;
    const tasksPromise = new Promise((resolve) => {
      fulfillTasks = resolve;
    });

    await page.route('**/manage/tasks', async (route) => {
      await tasksPromise;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ malformed: true }),
      });
    });

    await page.addInitScript((tok) => {
      window.sessionStorage.setItem('glassbox_management_token', tok);
    }, validToken);

    await page.goto('/manage?mode=live&page=ops');

    // 1. Loading state visible while response is pending
    const loadingNotice = page.locator('.pageContainer:has-text("加载任务数据中...")');
    await expect(loadingNotice).toBeVisible();

    // 2. Fulfill with malformed payload
    fulfillTasks();

    // 3. Error state rendered with role="alert" and PayloadValidationError explanation
    const errorAlert = page.locator('div[role="alert"]');
    await expect(errorAlert).toBeVisible();
    await expect(errorAlert).toContainText('任务数据加载失败');
    await expect(errorAlert).toContainText('PayloadValidationError');

    // 4. Invariant: Never falls back to fixture task data
    await expect(page.locator('text=task-218')).not.toBeVisible();
  });

  // 14. Current TaskAttempt WorkerBinding resolution in DetailRail
  test('resolves WorkerBinding strictly from current attempt number in DetailRail', async ({
    page,
  }) => {
    const validToken = 'abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE';

    await page.route('**/manage/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          service: 'glassbox',
          version: '0.0.0',
          status: 'ready',
          platform: 'linux',
          defaultExecution: 'claude-code',
          capabilities: {
            modelConfiguration: true,
            channels: true,
            conversations: true,
            runs: true,
            trace: true,
            eval: true,
          },
        }),
      });
    });

    // Task with attempt 1 bound, but current attempt 2 UNBOUND
    const controlledTask = {
      id: 'task-live-test',
      title: 'Current Attempt Binding Verification Task',
      state: 'RUNNING',
      priority: 'normal',
      creatorPrincipal: 'owner_primary',
      conversationId: 'conv-1',
      currentAttemptNo: 2,
      attempts: [
        {
          attemptNo: 1,
          status: 'COMPLETED',
          runId: 'run-old',
          durationMs: 1200,
          testResults: { passed: 5, total: 5 },
          workerBinding: {
            herdrSession: 'session-old-1',
            workspaceName: 'workspace-old-attempt',
            paneName: 'pane-old',
            workerType: 'codex',
            branch: 'branch-old',
            lastObservedAt: '2026-09-18T10:00:00Z',
          },
        },
        {
          attemptNo: 2,
          status: 'RUNNING',
          runId: 'run-current',
          durationMs: 400,
          testResults: { passed: 0, total: 5 },
          // No workerBinding on current attempt!
        },
      ],
      herdrState: 'working',
      herdrObservationMeta: 'Attempt 2 running without physical binding',
      requiresReview: false,
      createdAt: '2026-09-18T10:00:00Z',
      updatedAt: '2026-09-18T10:15:00Z',
    };

    await page.route('**/manage/tasks', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([controlledTask]),
      });
    });

    await page.addInitScript((tok) => {
      window.sessionStorage.setItem('glassbox_management_token', tok);
    }, validToken);

    await page.goto('/manage?mode=live&page=ops');

    // Select the task to open DetailRail
    const taskRow = page.locator('tr:has-text("task-live-test")');
    await expect(taskRow).toBeVisible();
    await taskRow.click();

    const detailRail = page.locator('.detailRail');
    await expect(detailRail).toBeVisible();

    // Invariant: Current attempt 2 has no binding -> Honest unbound state
    await expect(detailRail).toContainText('未绑定物理 Worker (无 WorkerBinding 记录)');
    // Must NEVER fall back to attempt 1's binding
    await expect(detailRail).not.toContainText('workspace-old-attempt');
    await expect(detailRail).not.toContainText('session-old-1');
  });

  // 15. Single-point ChartPanel rendering without NaN or console warnings
  test('renders single-point ChartPanel without NaN attributes or console warnings', async ({
    page,
  }) => {
    const validToken = 'abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE';

    await page.route('**/manage/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          service: 'glassbox',
          version: '0.0.0',
          status: 'ready',
          platform: 'linux',
          defaultExecution: 'claude-code',
          capabilities: {
            modelConfiguration: true,
            channels: true,
            conversations: true,
            runs: true,
            trace: true,
            eval: true,
          },
        }),
      });
    });

    // Monitor telemetry with exactly ONE latency trend data point
    const singlePointMonitor = {
      systemHealth: 'healthy',
      piEngine: {
        status: 'healthy',
        p95LatencyMs: 142,
        activeSessions: 1,
      },
      herdrBridge: {
        status: 'connected',
        activeWorkspaces: 2,
        activePanes: 3,
        lastHeartbeat: '刚刚',
      },
      persistence: {
        tursoStatus: 'healthy',
        r2Status: 'healthy',
      },
      webSocketConnected: true,
      alerts: [],
      latencyTrend: [
        {
          timestamp: '14:00',
          p50: 120,
          p95: 350,
        },
      ],
    };

    await page.route('**/manage/monitor/telemetry', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([singlePointMonitor]),
      });
    });

    await page.addInitScript((tok) => {
      window.sessionStorage.setItem('glassbox_management_token', tok);
    }, validToken);

    await page.goto('/manage?mode=live&page=monitor');
    await expect(page.locator('h1')).toContainText('系统监控');

    // Locate the circles inside the chart SVG
    const chartPanel = page.locator('.chartPanel');
    await expect(chartPanel).toBeVisible();

    const circles = chartPanel.locator('svg circle');
    const circleCount = await circles.count();
    expect(circleCount).toBeGreaterThan(0);

    for (let i = 0; i < circleCount; i++) {
      const circle = circles.nth(i);
      const cx = await circle.getAttribute('cx');
      const cy = await circle.getAttribute('cy');
      expect(cx).toBeTruthy();
      expect(cx).not.toContain('NaN');
      expect(cy).toBeTruthy();
      expect(cy).not.toContain('NaN');
      // Geometry-relative rather than a magic coordinate: a single-point series must land
      // inside the plot area (paddingX 30 … width 570) instead of at NaN or 0.
      const cxValue = Number(cx);
      expect(cxValue).toBeGreaterThan(30);
      expect(cxValue).toBeLessThan(570);
      expect(Number(cy)).toBeGreaterThanOrEqual(0);
    }
  });

  // 20. Runs deep link, row selection URL update, Trace handoff, and back/forward restoration
  test('supports Runs deep link, row selection URL update, Trace handoff, and back/forward restoration', async ({
    page,
  }) => {
    // 1. Deep link to valid run opens that run in DetailRail
    await page.goto('/manage?page=runs&runId=run_A79');
    const detailRail = page.locator('.detailRail');
    await expect(detailRail).toBeVisible();
    await expect(detailRail).toContainText('run_A79');
    await expect(detailRail).toContainText('gpt-4o');

    // 2. Selecting another run row updates runId in URL
    const runRowA83 = page.locator('tr:has-text("run_A83")').first();
    await runRowA83.click();
    await expect(page).toHaveURL(/runId=run_A83/);
    await expect(detailRail).toContainText('run_A83');

    // 3. "跳转查看执行追踪" handoff opens Trace with the selected Run ID
    const traceBtn = page.locator('button:has-text("跳转查看执行追踪")');
    await expect(traceBtn).toBeVisible();
    await traceBtn.click();
    await expect(page).toHaveURL(/page=trace/);
    await expect(page).toHaveURL(/runId=run_A83/);
    await expect(page.locator('h1')).toContainText('追踪');
    await expect(page.locator('.traceRunItem.active')).toContainText('run_A83');

    // 4. Trace Run selection updates URL search state
    const traceRunA79 = page.locator('.traceRunItem:has-text("run_A79")');
    await traceRunA79.click();
    await expect(page).toHaveURL(/runId=run_A79/);

    // 5. Browser back and forward restore selection
    await page.goBack();
    await expect(page).toHaveURL(/runId=run_A83/);
    await expect(page.locator('.traceRunItem.active')).toContainText('run_A83');

    await page.goBack(); // Back to Runs page with run_A83
    await expect(page).toHaveURL(/page=runs/);
    await expect(page).toHaveURL(/runId=run_A83/);
    await expect(page.locator('.detailRail')).toBeVisible();
    await expect(page.locator('.detailRail')).toContainText('run_A83');

    await page.goForward(); // Forward to Trace with run_A83
    await expect(page).toHaveURL(/page=trace/);
    await expect(page).toHaveURL(/runId=run_A83/);

    // 6. Invalid runId does not select wrong entity; renders honest not-found notice without DetailRail
    await page.goto('/manage?page=runs&runId=invalid_nonexistent_run');
    await expect(page.locator('.detailRail')).not.toBeVisible();
    await expect(page.locator('text=未找到指定运行 [invalid_nonexistent_run]')).toBeVisible();
  });

  // 21. Enforces no initial focus theft across pages
  test('enforces no initial focus theft across pages with DetailRail or mobile menu', async ({
    page,
  }) => {
    // 1. Initial desktop mount on Permissions page (where DetailRail is open by default)
    await page.goto('/manage?page=permissions');
    await expect(page.locator('h1')).toContainText('权限控制面');

    // Focus must NOT be stolen by DetailRail on mount
    const focusedTag = await page.evaluate(() => document.activeElement?.tagName);
    expect(focusedTag === 'BODY' || focusedTag === undefined).toBe(true);

    // 2. Mobile mount (390x844): focus must NOT be stolen by mobileMenuBtn on mount
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/manage?page=overview');
    await expect(page.locator('h1')).toContainText('概览');

    const mobileFocusedTag = await page.evaluate(() => document.activeElement?.tagName);
    expect(mobileFocusedTag === 'BODY' || mobileFocusedTag === undefined).toBe(true);
  });

  // 22. Mobile Drawer and Command Palette focus containment and focus restoration
  test('supports Drawer and Command Palette focus containment, Escape dismissal, and focus restoration', async ({
    page,
  }) => {
    // Command Palette on Desktop
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/manage?page=overview');

    const cmdBtn = page.locator('button[aria-label*="Cmd+K"]');
    await cmdBtn.focus();
    await cmdBtn.click();

    const cmdDialog = page.locator('div[role="dialog"][aria-label="Command Palette"]');
    await expect(cmdDialog).toBeVisible();
    await expect(cmdDialog).toHaveAttribute('aria-modal', 'true');

    // Search input is auto-focused
    const cmdInput = cmdDialog.locator('input[type="text"]');
    await expect(cmdInput).toBeFocused();

    // Tab containment: Shift+Tab wraps to last item
    await page.keyboard.press('Shift+Tab');
    const lastItem = cmdDialog.locator('.cmdPaletteItem').last();
    await expect(lastItem).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(cmdInput).toBeFocused();

    // Escape closes palette and restores focus to cmdBtn
    await page.keyboard.press('Escape');
    await expect(cmdDialog).not.toBeVisible();
    await expect(cmdBtn).toBeFocused();

    // Mobile Drawer focus containment and restoration
    await page.setViewportSize({ width: 390, height: 844 });
    const menuBtn = page.locator('.mobileMenuBtn');
    await menuBtn.focus();
    await menuBtn.click();

    const drawer = page.locator('.mobileDrawer.open');
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute('aria-modal', 'true');

    // Tab wraps within drawer
    await page.keyboard.press('Tab');
    const activeInsideDrawer = await page.evaluate(() =>
      document.querySelector('.mobileDrawer')?.contains(document.activeElement),
    );
    expect(activeInsideDrawer).toBe(true);

    // Escape closes drawer and restores focus to menuBtn
    await page.keyboard.press('Escape');
    await expect(drawer).not.toBeVisible();
    await expect(menuBtn).toBeFocused();
  });

  // 23. Command Palette filtering, empty state, and query reset
  test('supports Command Palette filtering, empty state, and query reset', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/manage?page=overview');

    const cmdBtn = page.locator('button[aria-label*="Cmd+K"]');
    await cmdBtn.click();

    const cmdDialog = page.locator('div[role="dialog"][aria-label="Command Palette"]');
    const cmdInput = cmdDialog.locator('input[type="text"]');

    // Filter by Chinese title
    await cmdInput.fill('会话');
    await expect(cmdDialog.locator('.cmdPaletteItem')).toHaveCount(1);
    await expect(cmdDialog.locator('.cmdPaletteItem')).toContainText('会话 (Conversations)');

    // Filter by English title / ID
    await cmdInput.fill('trace');
    await expect(cmdDialog.locator('.cmdPaletteItem')).toHaveCount(1);
    await expect(cmdDialog.locator('.cmdPaletteItem')).toContainText('追踪 (Trace)');

    // Empty search result
    await cmdInput.fill('xyz_nonexistent_search');
    await expect(cmdDialog.locator('.cmdPaletteItem')).toHaveCount(0);
    await expect(cmdDialog).toContainText('无匹配页面或操作');

    // Close and reopen: query resets to empty and shows all 11 items
    await page.keyboard.press('Escape');
    await expect(cmdDialog).not.toBeVisible();

    await cmdBtn.click();
    await expect(cmdInput).toHaveValue('');
    await expect(cmdDialog.locator('.cmdPaletteItem')).toHaveCount(11);
    await page.keyboard.press('Escape');
  });

  // 24. Permissions Rail close, Escape, and reopen
  test('supports Permissions Rail close, Escape, and reopen', async ({
    page,
  }) => {
    await page.goto('/manage?page=permissions');
    await expect(page.locator('h1')).toContainText('权限控制面');

    const detailRail = page.locator('.detailRail');
    await expect(detailRail).toBeVisible();
    await expect(detailRail).toContainText('决策模拟器 (Decision Tester)');

    // Close via close button
    const closeBtn = detailRail.locator('.detailRailClose');
    await closeBtn.click();
    await expect(detailRail).not.toBeVisible();

    // Reopen button is visible
    const reopenBtn = page.locator('button:has-text("打开决策模拟器")');
    await expect(reopenBtn).toBeVisible();

    // Click reopen
    await reopenBtn.click();
    await expect(detailRail).toBeVisible();
    await expect(reopenBtn).not.toBeVisible();

    // Close via Escape key
    await page.keyboard.press('Escape');
    await expect(detailRail).not.toBeVisible();
    await expect(reopenBtn).toBeVisible();
  });

  // 25. Trace keyboard selection scrolling within long event list and respects prefers-reduced-motion
  test('supports Trace keyboard selection scrolling within long event list and respects prefers-reduced-motion', async ({
    page,
  }) => {
    // Scale tier 100 events using real run_A81
    await page.goto('/manage?page=trace&runId=run_A81');
    await expect(page.locator('h1')).toContainText('追踪');

    // Assert the active Run option is run_A81 and event count is 100
    const activeRunItem = page.locator('.traceRunItem.active');
    await expect(activeRunItem).toBeVisible();
    await expect(activeRunItem).toContainText('run_A81');
    await expect(activeRunItem).toContainText('100 事件');

    const timelineList = page.locator('.timelineList');
    await expect(timelineList).toBeVisible();

    // Focus inside page outside input
    await page.locator('h1').click();

    // Press 'End' to select the last event in the 100-event run
    await page.keyboard.press('End');

    // Assert the last event is active and the timeline scrollTop is greater than 0
    const lastEvent = timelineList.locator('.timelineEventItem').last();
    const lastEventText = await lastEvent.textContent();
    const activeText = await timelineList.locator('.timelineEventItem.active').textContent();
    expect(activeText).toBe(lastEventText);

    // Observable DOM state: scrollTop of .timelineList must have scrolled
    await expect.poll(async () => {
      return timelineList.evaluate((el) => el.scrollTop);
    }).toBeGreaterThan(0);

    // Test with prefers-reduced-motion
    await page.emulateMedia({ reducedMotion: 'reduce' });

    // Navigate back to beginning with Home and assert selection and scrolling return toward top
    await page.keyboard.press('Home');
    await expect(timelineList.locator('.timelineEventItem.active')).toContainText('#1');
    const homeScrolled = await timelineList.evaluate((el) => el.scrollTop);
    expect(homeScrolled).toBeLessThan(100);

    // Under reduced motion, End navigates immediately and scrolls without relying on smooth animation timing
    await page.keyboard.press('End');
    const activeTextReduced = await timelineList.locator('.timelineEventItem.active').textContent();
    expect(activeTextReduced).toBe(lastEventText);
    const reducedScrolledTop = await timelineList.evaluate((el) => el.scrollTop);
    expect(reducedScrolledTop).toBeGreaterThan(homeScrolled);
  });

  // 26. Settings saved session draft surviving navigation and reload, disabling Trace shortcuts, hiding unknown costs, and color-blind root state
  test('supports Settings saved session draft surviving navigation and reload, disabling Trace shortcuts, hiding unknown costs, and color-blind root state', async ({
    page,
  }) => {
    await page.goto('/manage?page=settings');
    await expect(page.locator('h1')).toContainText('系统设置');

    // 1. Configure settings
    const pricingSelect = page.locator('select#setting-unknown-price');
    await pricingSelect.selectOption('hide_cost');

    const shortcutsCheckbox = page.locator('input#setting-shortcuts');
    await shortcutsCheckbox.uncheck();

    const colorBlindCheckbox = page.locator('input#setting-colorblind');
    await colorBlindCheckbox.check();

    // Save draft
    const saveBtn = page.locator('button:has-text("保存设置草稿")');
    await saveBtn.click();
    await expect(page.locator('[role="alert"]')).toContainText(
      '[本地设计草稿] 设置已保存在浏览器临时会话中，未持久化至服务端配置。',
    );

    // 2. Color-blind mode applied at app root
    const appRoot = page.locator('.managementApp');
    await expect(appRoot).toHaveAttribute('data-colorblind', 'true');
    await expect(appRoot).toHaveClass(/colorblind-mode/);

    // 3. Navigate away to Overview and check persistence & cost hiding
    const navOverview = page.locator('.sidebarNav button.navItem:has-text("概览")');
    await navOverview.click();
    await expect(page).toHaveURL(/page=overview/);
    await expect(appRoot).toHaveAttribute('data-colorblind', 'true');
    await expect(page.locator('th:has-text("预估费用")')).toHaveCount(0);

    // 4. In Runs DetailRail, unknown cost row is hidden without rendering zero
    await page.goto('/manage?page=runs&runId=run_A83');
    const detailRail = page.locator('.detailRail');
    await expect(detailRail).toBeVisible();
    await expect(detailRail).not.toContainText('成本不可用');
    await expect(detailRail).not.toContainText('$0.00');

    // 5. In Trace, keyboard shortcuts are disabled
    await page.goto('/manage?page=trace&runId=run_A83');
    await page.locator('h1').click();
    const activeEventTextBefore = await page.locator('.timelineEventItem.active').innerText();
    await page.keyboard.press('j');
    const activeEventTextAfter = await page.locator('.timelineEventItem.active').innerText();
    expect(activeEventTextAfter).toBe(activeEventTextBefore);

    // 6. Return to Settings and reload: draft survives in browser session
    await page.goto('/manage?page=settings');
    await expect(pricingSelect).toHaveValue('hide_cost');
    await expect(shortcutsCheckbox).not.toBeChecked();
    await expect(colorBlindCheckbox).toBeChecked();

    await page.reload();
    await expect(page.locator('select#setting-unknown-price')).toHaveValue('hide_cost');
    await expect(page.locator('input#setting-shortcuts')).not.toBeChecked();
    await expect(page.locator('input#setting-colorblind')).toBeChecked();
  });

  // 27. PI model switch, controlled temperature edit, truthful local apply feedback, and accessible profile label
  test('supports PI model switch, controlled temperature edit, truthful local apply feedback, and accessible profile label', async ({
    page,
  }) => {
    await page.goto('/manage?page=pi');
    await expect(page.locator('h1')).toContainText('PI 执行核心');

    const modelSelect = page.locator('select#pi-default-model');
    const tempInput = page.locator('input#pi-temp');
    const applyBtn = page.locator('button:has-text("应用参数")');

    // Initial model is Claude 3.5 Sonnet with temperature 0.2
    await expect(tempInput).toHaveValue('0.2');

    // Switch to GPT-4o (defaults to 0.7)
    await modelSelect.selectOption({ label: 'GPT-4o (多模态与快响应) (openai)' });
    await expect(tempInput).toHaveValue('0.7');

    // Edit temperature to 0.5 (controlled local draft)
    await tempInput.fill('0.5');
    await expect(tempInput).toHaveValue('0.5');

    // Click Apply
    await applyBtn.click();
    const notice = page.locator('[role="alert"]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('[设计模拟]');
    await expect(notice).toContainText('未向服务端持久化');

    // Switch back to Claude (temperature 0.2 preserved)
    await modelSelect.selectOption({ label: 'Claude 3.5 Sonnet (默认执行核心) (anthropic)' });
    await expect(tempInput).toHaveValue('0.2');

    // Label association for Lora PI Kit profile
    const profileLabel = page.locator('label[for="pi-kit-profile"]');
    await expect(profileLabel).toBeVisible();
    const profileValue = page.locator('#pi-kit-profile');
    await expect(profileValue).toBeVisible();
    await expect(profileValue).toContainText('lora-pi-kit:p3-closed-loop');
  });

  // 28. aria-selected updates on selectable rows/items and omitted on static tables
  test('verifies aria-selected updates on selectable rows/items and omits on static tables', async ({
    page,
  }) => {
    // Selectable DataTable in Runs
    await page.goto('/manage?page=runs&runId=run_A83');
    const selectedRow = page.locator('tr.selected');
    await expect(selectedRow).toHaveAttribute('aria-selected', 'true');

    const unselectedRow = page.locator('.dataTable tbody tr:not(.selected)').first();
    await expect(unselectedRow).toHaveAttribute('aria-selected', 'false');

    // Static table in Permissions does NOT have aria-selected on rows
    await page.goto('/manage?page=permissions');
    const staticRows = page.locator('.dataTable tbody tr');
    const count = await staticRows.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < Math.min(count, 3); i++) {
      await expect(staticRows.nth(i)).not.toHaveAttribute('aria-selected');
    }

    // Selectable items in Trace
    await page.goto('/manage?page=trace&runId=run_A83');
    const activeRunItem = page.locator('.traceRunItem.active');
    await expect(activeRunItem).toHaveAttribute('aria-selected', 'true');

    const activeTimelineItem = page.locator('.timelineEventItem.active');
    await expect(activeTimelineItem).toHaveAttribute('aria-selected', 'true');
  });

  // 29. Breadcrumb displays Glassbox instead of GlossBox
  test('verifies breadcrumb displays Glassbox instead of GlossBox', async ({
    page,
  }) => {
    await page.goto('/manage?page=overview');
    const breadcrumb = page.locator('.breadcrumb');
    await expect(breadcrumb).toContainText('Glassbox /');
    await expect(breadcrumb).not.toContainText('GlossBox');
  });

  // 30. Identity and Channels DetailRail inspection, simulation handoff, Trace navigation, and Escape/Close dismissals
  test('supports Identity and Channels DetailRail inspection, simulation handoff, Trace navigation, and Escape/Close dismissals', async ({
    page,
  }) => {
    // 1. Identity DetailRail
    await page.goto('/manage?page=identity');
    await expect(page.locator('h1')).toContainText('身份与访问');

    const identityRail = page.locator('.detailRail');
    await expect(identityRail).toBeVisible();
    await expect(identityRail).toContainText('owner_primary');
    await expect(identityRail).toContainText('渠道身份映射链条');

    // Click "以此主体测试 (模拟)" -> navigates to permissions with testPrincipal
    const testSimulationBtn = identityRail.locator('button:has-text("以此主体测试 (模拟)")');
    await expect(testSimulationBtn).toBeVisible();
    await testSimulationBtn.click();
    await expect(page).toHaveURL(/page=permissions.*testPrincipal=owner_primary/);
    await expect(page.locator('input#test-principal')).toHaveValue('owner_primary');

    // Return to Identity and test selection and Escape dismissal
    await page.goto('/manage?page=identity');
    await expect(identityRail).toBeVisible();
    const workerPrincipalRow = page.locator('tr:has-text("worker_herdr_04")');
    await workerPrincipalRow.click();
    await expect(identityRail).toContainText('worker_herdr_04');

    // Escape closes rail
    await page.keyboard.press('Escape');
    await expect(identityRail).not.toBeVisible();

    // Clicking row reopens rail
    await workerPrincipalRow.click();
    await expect(identityRail).toBeVisible();

    // Close button closes rail
    await identityRail.locator('.detailRailClose').click();
    await expect(identityRail).not.toBeVisible();

    // 2. Channels DetailRail
    await page.goto('/manage?page=channels');
    await expect(page.locator('h1')).toContainText('渠道与集成');

    const channelRail = page.locator('.detailRail');
    await expect(channelRail).toBeVisible();
    await expect(channelRail).toContainText('OneBot 11');
    await expect(channelRail).toContainText('门禁策略配置');

    // Click "查看该渠道相关 Trace 记录"
    const traceNavBtn = channelRail.locator('button:has-text("查看该渠道相关 Trace 记录")');
    await expect(traceNavBtn).toBeVisible();
    await traceNavBtn.click();
    await expect(page).toHaveURL(/page=trace/);

    // Return to Channels and test Escape and Close button dismissals
    await page.goto('/manage?page=channels');
    await expect(channelRail).toBeVisible();
    const webChannelRow = page.locator('tr:has-text("chan_web_admin")');
    await webChannelRow.click();
    await expect(channelRail).toContainText('chan_web_admin');

    // Escape closes rail
    await page.keyboard.press('Escape');
    await expect(channelRail).not.toBeVisible();

    // Reopen and close via button
    await webChannelRow.click();
    await expect(channelRail).toBeVisible();
    await channelRail.locator('.detailRailClose').click();
    await expect(channelRail).not.toBeVisible();
  });

  // 31. Supports token rotation, cache isolation, and credential persistence in live mode
  test('supports token rotation, cache isolation, and credential persistence in live mode', async ({
    page,
  }) => {
    const tokenA = 'valid_token_alpha_0123456789_abcdefghijklm_';
    const tokenB = 'valid_token_bravo_0123456789_abcdefghijklm_';

    let lastAuthHeader = '';
    await page.route('**/manage/status', (route) => {
      lastAuthHeader = route.request().headers()['authorization'] || '';
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          service: 'glassbox',
          version: '0.8.4',
          status: 'ready',
          platform: 'linux',
          defaultExecution: 'pi',
          capabilities: { modelConfiguration: true, channels: true },
        }),
      });
    });

    await page.route('**/manage/overview', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          runs24h: 120,
          pendingAttentionCount: 2,
          currentRun: null,
          attentionQueue: [],
        }),
      });
    });

    await page.route('**/manage/models', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ profiles: [] }),
      });
    });

    await page.route('**/manage/channels', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ channels: [] }),
      });
    });

    // 1. Submit token A
    await page.goto('/manage?mode=live&page=overview');
    const tokenInput = page.locator('#mgmt-token-input');
    await tokenInput.fill(tokenA);
    await page.locator('button[type="submit"]').click();

    await expect(page.locator('.sidebarNav')).toBeVisible();
    expect(lastAuthHeader).toBe(`Bearer ${tokenA}`);

    // Credential persisted in sessionStorage
    const storedToken = await page.evaluate(() => sessionStorage.getItem('glassbox_management_token'));
    expect(storedToken).toBe(tokenA);

    // 2. Reload page: credential survives and stays in live mode without prompting
    await page.reload();
    await expect(page.locator('.sidebarNav')).toBeVisible();
    // Scope to the topbar data-source badge: page headers also render .capabilityBadge.ok,
    // so an unscoped locator would resolve to multiple elements.
    await expect(
      page.locator('.topbar .repoMeta .capabilityBadge'),
    ).toContainText('实时接口 (/manage)');

    // 3. Rotate token via sessionStorage and verify cache isolation
    await page.evaluate((tok) => {
      sessionStorage.setItem('glassbox_management_token', tok);
      window.dispatchEvent(new Event('storage'));
    }, tokenB);

    await page.reload();
    await expect(page.locator('.sidebarNav')).toBeVisible();
    expect(lastAuthHeader).toBe(`Bearer ${tokenB}`);
  });

  // 32. Enforces closed mobile drawer is absent from accessibility tree and tab order
  test('enforces closed mobile drawer is absent from accessibility tree and tab order', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/manage?page=overview');

    const drawer = page.locator('.mobileDrawer');
    await expect(drawer).toBeHidden();
    await expect(drawer).toHaveAttribute('aria-hidden', 'true');

    // Tab through initial controls on page
    await page.keyboard.press('Tab');
    const activeTagName = await page.evaluate(() => document.activeElement?.tagName);
    expect(activeTagName).toBeTruthy();

    // Verify activeElement is not inside .mobileDrawer
    const isInsideDrawer = await page.evaluate(() => {
      const drawerEl = document.querySelector('.mobileDrawer');
      return drawerEl ? drawerEl.contains(document.activeElement) : false;
    });
    expect(isInsideDrawer).toBe(false);
  });

  // 33. Enforces mobile topbar geometry, 16px font on inputs/selects, and key touch targets >= 44px
  test('enforces mobile topbar geometry, 16px font on inputs/selects, and key touch targets >= 44px', async ({
    page,
  }) => {
    const mobileViewports = [
      { name: 'narrow-mobile (320x700)', width: 320, height: 700 },
      { name: 'mobile (390x844)', width: 390, height: 844 },
    ];

    for (const vp of mobileViewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/manage?page=overview');
      await page.waitForLoadState('domcontentloaded');

      const topbar = page.locator('.topbar');
      const topbarBox = await topbar.boundingBox();
      expect(topbarBox, `Topbar bounding box should exist at ${vp.name}`).not.toBeNull();
      expect(topbarBox.height, `Topbar height >= 52px at ${vp.name}`).toBeGreaterThanOrEqual(52);

      const pageHeader = page.locator('.pageHeader');
      const pageHeaderBox = await pageHeader.boundingBox();
      expect(pageHeaderBox, `PageHeader bounding box should exist at ${vp.name}`).not.toBeNull();

      const h1 = page.locator('.pageHeader h1');
      const h1Box = await h1.boundingBox();
      expect(h1Box, `H1 bounding box should exist at ${vp.name}`).not.toBeNull();

      // Criterion 2: Topbar bottom is strictly above or equal to PageHeader top and H1 top (zero overlap)
      expect(
        topbarBox.y + topbarBox.height,
        `Topbar bottom (${topbarBox.y + topbarBox.height}) must be <= PageHeader top (${pageHeaderBox.y}) at ${vp.name}`,
      ).toBeLessThanOrEqual(pageHeaderBox.y + 0.5);

      expect(
        topbarBox.y + topbarBox.height,
        `Topbar bottom (${topbarBox.y + topbarBox.height}) must be <= H1 top (${h1Box.y}) at ${vp.name}`,
      ).toBeLessThanOrEqual(h1Box.y + 0.5);

      // Key topbar controls
      const menuBtn = page.locator('.mobileMenuBtn');
      const crumb = page.locator('.breadcrumb');
      const repoMeta = page.locator('.repoMeta');
      const cmdKBtn = page.locator('.topbar button:has-text("⌘K")');
      const openConvLink = page.locator('.topbar a:has-text("打开对话")');
      const badge = page.locator('.topbar .capabilityBadge');
      const modeSwitchBtn = page.locator('.topbar .repoMeta button');

      // Criterion 4: All key controls remain visible and keyboard accessible
      await expect(menuBtn).toBeVisible();
      await expect(badge).toBeVisible();
      await expect(modeSwitchBtn).toBeVisible();
      await expect(modeSwitchBtn).toBeEnabled();
      await expect(cmdKBtn).toBeVisible();
      await expect(cmdKBtn).toBeEnabled();
      await expect(openConvLink).toBeVisible();
      await expect(openConvLink).toHaveAttribute('href', /.+/);

      // Menu button touch target >= 44px
      const menuBtnBox = await menuBtn.boundingBox();
      expect(menuBtnBox.width).toBeGreaterThanOrEqual(44);
      expect(menuBtnBox.height).toBeGreaterThanOrEqual(44);

      // Criterion 1: Every visible topbar action is entirely within the topbar bounding rectangle
      const visibleElements = [
        { name: 'menuBtn', locator: menuBtn },
        { name: 'breadcrumb', locator: crumb },
        { name: 'repoMeta', locator: repoMeta },
        { name: 'cmdKBtn', locator: cmdKBtn },
        { name: 'openConvLink', locator: openConvLink },
      ];

      const itemBoxes = [];
      for (const item of visibleElements) {
        const box = await item.locator.boundingBox();
        expect(box, `${item.name} box should exist at ${vp.name}`).not.toBeNull();

        // Enclosed within topbar bounding box (with 1px subpixel tolerance)
        expect(
          box.y,
          `${item.name} top (${box.y}) must be >= topbar top (${topbarBox.y}) at ${vp.name}`,
        ).toBeGreaterThanOrEqual(topbarBox.y - 1);

        expect(
          box.y + box.height,
          `${item.name} bottom (${box.y + box.height}) must be <= topbar bottom (${topbarBox.y + topbarBox.height}) at ${vp.name}`,
        ).toBeLessThanOrEqual(topbarBox.y + topbarBox.height + 1);

        expect(
          box.x,
          `${item.name} left (${box.x}) must be >= topbar left (${topbarBox.x}) at ${vp.name}`,
        ).toBeGreaterThanOrEqual(topbarBox.x - 1);

        expect(
          box.x + box.width,
          `${item.name} right (${box.x + box.width}) must be <= topbar right (${topbarBox.x + topbarBox.width}) at ${vp.name}`,
        ).toBeLessThanOrEqual(topbarBox.x + topbarBox.width + 1);

        // Explicitly verify action is above H1 top
        expect(
          box.y + box.height,
          `${item.name} bottom must be <= H1 top at ${vp.name}`,
        ).toBeLessThanOrEqual(h1Box.y + 0.5);

        itemBoxes.push({ name: item.name, box });
      }

      // Criterion 3: Visible sibling topbar actions do not intersect each other
      for (let i = 0; i < itemBoxes.length; i++) {
        for (let j = i + 1; j < itemBoxes.length; j++) {
          const a = itemBoxes[i];
          const b = itemBoxes[j];
          const overlaps = !(
            a.box.x + a.box.width <= b.box.x + 0.5 ||
            b.box.x + b.box.width <= a.box.x + 0.5 ||
            a.box.y + a.box.height <= b.box.y + 0.5 ||
            b.box.y + b.box.height <= a.box.y + 0.5
          );
          expect(
            overlaps,
            `Sibling items "${a.name}" and "${b.name}" must not intersect at ${vp.name}`,
          ).toBe(false);
        }
      }

      // Criterion 5: Breadcrumb has stable flex layout with ellipsis styling and no overflow
      const crumbStyles = await page.locator('#crumb').evaluate((el) => {
        const cs = window.getComputedStyle(el);
        return {
          overflow: cs.overflow,
          textOverflow: cs.textOverflow,
          whiteSpace: cs.whiteSpace,
        };
      });
      expect(crumbStyles.overflow).toBe('hidden');
      expect(crumbStyles.textOverflow).toBe('ellipsis');
      expect(crumbStyles.whiteSpace).toBe('nowrap');

      // Criterion 6: Zero page-level horizontal overflow
      const hasHorizontalOverflow = await page.evaluate(() => {
        // clientWidth excludes the scrollbar gutter; window.innerWidth does not.
        return (
          document.documentElement.scrollWidth > document.documentElement.clientWidth ||
          document.body.scrollWidth > document.documentElement.clientWidth
        );
      });
      expect(hasHorizontalOverflow, `Horizontal page overflow at ${vp.name}`).toBe(false);
    }

    // Input/select 16px font size check on Settings page to prevent iOS auto-zoom
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/manage?page=settings');

    const inputFontSize = await page.locator('input#setting-retention').evaluate((el) => {
      return window.getComputedStyle(el).fontSize;
    });
    expect(inputFontSize).toBe('16px');

    const selectFontSize = await page.locator('select#setting-language').evaluate((el) => {
      return window.getComputedStyle(el).fontSize;
    });
    expect(selectFontSize).toBe('16px');
  });

  // 34. Verifies zero duplicate element IDs and no console errors across all 11 pages
  test('verifies zero duplicate element IDs and no console errors across all 11 pages', async ({
    page,
  }) => {
    const consoleErrors = [];
    page.on('console', (msg) => {
      // Mirror the global filter in beforeEach so this stricter local check cannot fail on
      // noise the suite already forgives (favicon, 404).
      if (
        msg.type() === 'error' &&
        !msg.text().includes('favicon.ico') &&
        !msg.text().includes('404')
      ) {
        consoleErrors.push(msg.text());
      }
    });

    const pages = [
      'overview',
      'conversations',
      'ops',
      'identity',
      'runs',
      'trace',
      'pi',
      'channels',
      'permissions',
      'monitor',
      'settings',
    ];

    for (const pageId of pages) {
      await page.goto(`/manage?page=${pageId}`);
      await page.waitForLoadState('domcontentloaded');

      // Check duplicate IDs
      const duplicateIds = await page.evaluate(() => {
        const elementsWithId = document.querySelectorAll('[id]');
        const seen = new Set();
        const duplicates = [];
        for (const el of elementsWithId) {
          const id = el.id.trim();
          if (!id) continue;
          if (seen.has(id)) {
            duplicates.push(id);
          } else {
            seen.add(id);
          }
        }
        return duplicates;
      });

      expect(
        duplicateIds,
        `Duplicate element IDs found on page "${pageId}": ${duplicateIds.join(', ')}`,
      ).toEqual([]);
    }

    expect(consoleErrors).toEqual([]);
  });

  // 35. Verifies R-01 through R-03: live mode truthful unknown values, no fixture-only metrics/sections, and Trace/Permissions error/loading differentiation
  test('verifies R-01 through R-03: live mode truthful unknown values, no fixture-only metrics/sections, and Trace/Permissions error/loading differentiation', async ({
    page,
  }) => {
    const liveToken = 'valid_token_reviewer_0123456789_abcdefghijk';

    // Route canonical endpoints
    await page.route('**/manage/status', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          service: 'glassbox',
          version: '0.8.4',
          status: 'ready',
          platform: 'linux',
          defaultExecution: 'pi',
          capabilities: { modelConfiguration: true, channels: true },
        }),
      });
    });

    await page.route('**/manage/models', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          profiles: [
            {
              id: 'claude-3-5-sonnet',
              label: 'Claude 3.5 Sonnet',
              protocol: 'anthropic',
              baseUrl: 'https://api.anthropic.com',
              model: 'claude-3-5-sonnet-20241022',
              credentialConfigured: true,
            },
          ],
        }),
      });
    });

    await page.route('**/manage/channels', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          channels: [
            {
              id: 'chan_onebot_qq',
              label: 'OneBot 11 QQ',
              kind: 'qq-onebot',
              endpoint: 'ws://127.0.0.1:3001',
              botId: '12345678',
              ownerId: '87654321',
              groupIds: ['10001'],
              tokenConfigured: true,
              autoConnect: true,
              connectionState: 'connected',
            },
          ],
        }),
      });
    });

    await page.route('**/manage/tasks', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ tasks: [] }),
      });
    });

    await page.route('**/manage/principals', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ principals: [] }),
      });
    });

    await page.route('**/manage/permissions/rules', (route) => {
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Endpoint not available' }),
      });
    });

    await page.route('**/manage/monitor/telemetry', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            systemHealth: 'healthy',
            piEngine: { status: 'healthy', p95LatencyMs: 1200, activeSessions: 0 },
            herdrBridge: { status: 'connected', activeWorkspaces: 0, activePanes: 0, lastHeartbeat: '2026-09-18T12:00:00Z' },
            persistence: { tursoStatus: 'healthy', r2Status: 'healthy' },
            webSocketConnected: true,
            alerts: [],
            latencyTrend: [],
          },
        ]),
      });
    });

    await page.route('**/manage/runs', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          runs: [
            {
              id: 'run_live_test_1',
              conversationId: 'conv_live_1',
              principalId: 'owner_primary',
              status: 'completed',
              modelId: 'claude-3-5-sonnet',
              durationMs: 1250,
              toolsExecutedCount: 3,
              artifacts: [],
              tokens: { prompt: 1200, completion: 450, total: 1650 },
              costUsd: null,
              costStatus: 'unknown',
              startedAt: '2026-09-18T10:00:00Z',
              traceId: 'trace-run_live_test_1',
              summary: 'Live run execution summary',
            },
          ],
        }),
      });
    });

    await page.route('**/manage/runs/*/trace', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'ev-live-01',
            runId: 'run_live_test_1',
            sequence: 1,
            timestamp: '2026-09-18T10:00:01Z',
            type: 'tool',
            summary: 'Execute cargo check in workspace',
            payload: { tool: 'cargo_check', exitCode: 0 },
          },
        ]),
      });
    });

    // Authenticate in live mode
    await page.goto('/manage?mode=live');
    const tokenInput = page.locator('#mgmt-token-input');
    await tokenInput.fill(liveToken);
    await page.locator('button[type="submit"]').click();

    // 1. R-01 Verification on OverviewPage
    await page.goto('/manage?mode=live&page=overview');
    await expect(page.locator('h1')).toContainText('概览');

    const overviewSummary = page.locator('.summaryBar');
    // Must show 未知, never 196 or 3
    await expect(overviewSummary).toContainText('未知');
    await expect(overviewSummary).not.toContainText('196');
    await expect(overviewSummary).not.toContainText('3 个');
    await expect(page.locator('text=暂无需要 Owner 介入的待办事项')).toBeVisible();

    // 2. R-02 Verification: Live mode never displays named fixture-only sections
    // Ops: active worker count shows 未知, live-worker and reconciliation show P3 unavailable
    await page.goto('/manage?mode=live&page=ops');
    await expect(page.locator('h1')).toContainText('任务协作');
    const opsSummary = page.locator('.summaryBar');
    await expect(opsSummary).toContainText('未知');
    await expect(page.locator('text=实时 Worker 纳管接口暂不可用 (P3 目标：需要 HerdrBridge 实时连接)')).toBeVisible();
    await expect(page.locator('text=外部执行对齐流水线未接入 (P3 目标：待 Herdr 对齐事件总线打通)')).toBeVisible();
    // Fixture worker IDs (worker-01/04/07) must not leak into live mode.
    await expect(page.locator('text=worker-01')).toHaveCount(0);
    await expect(page.locator('text=worker-04')).toHaveCount(0);

    // Identity: resource relationships shows P3 unavailable
    await page.goto('/manage?mode=live&page=identity');
    await expect(page.locator('h1')).toContainText('身份与访问');
    await expect(page.locator('text=资源所有权追溯接口暂不可用 (P3 目标：需要细粒度资源注册表)')).toBeVisible();
    await expect(page.locator('text=workspace://glassbox-main')).not.toBeVisible();

    // PI: hardcoded 184,500 Token, fixture profiles, sessions, and usage rows not displayed
    await page.goto('/manage?mode=live&page=pi');
    await expect(page.locator('h1')).toContainText('PI 执行核心');
    const piSummary = page.locator('.summaryBar');
    await expect(piSummary).not.toContainText('184,500');
    await expect(page.locator('text=Profile 注册表接口暂不可用 (P3 目标：需要 Lora PI Kit 运行时注册表)')).toBeVisible();
    await expect(page.locator('text=会话池健康度接口暂不可用 (P3 目标：需要 SessionManager 监控上报)')).toBeVisible();
    await expect(page.locator('text=细粒度延迟与用量统计接口暂不可用 (P3 目标：需要遥测指标导出器)')).toBeVisible();
    await expect(page.locator('text=lora-pi-kit:p3-closed-loop')).not.toBeVisible();

    // Channels: contracts, identity mapping, activity fixtures not displayed
    await page.goto('/manage?mode=live&page=channels');
    await expect(page.locator('h1')).toContainText('渠道与集成');
    await expect(page.locator('text=渠道合约注册表接口暂不可用 (P3 目标：需要动态渠道合约配置 API)')).toBeVisible();
    await expect(page.locator('text=外部身份映射接口暂不可用 (P3 目标：需要 ChannelIdentity 映射解析存储)')).toBeVisible();
    await expect(page.locator('text=渠道出入站审计事件流暂不可用 (P3 目标：需要集中审计日志上报)')).toBeVisible();
    // Fixture contract rows (e.g. contract-email ingress rule) must not leak into live mode.
    await expect(page.locator('text=DKIM/SPF verification required')).toHaveCount(0);

    // Monitor: service health, storage, agent ops hardcoded metrics not displayed
    await page.goto('/manage?mode=live&page=monitor');
    await expect(page.locator('h1')).toContainText('系统监控');
    await expect(page.locator('text=子系统健康度明细接口暂不可用 (P3 目标：需要微服务探针注册表)')).toBeVisible();
    await expect(page.locator('text=Agent Ops 聚合指标管道暂不可用 (P3 目标：需要运营指标聚合服务)')).toBeVisible();
    await expect(page.locator('text=存储分层统计接口暂不可用 (P3 目标：需要存储引擎遥测探针)')).toBeVisible();
    // Fixture service health rows (svc_pi … svc_r2) must not leak into live mode.
    await expect(page.locator('text=svc_pi')).toHaveCount(0);
    await expect(page.locator('text=svc_r2')).toHaveCount(0);
    // Agent Ops figures are now derived from the task projection, never a hardcoded literal.
    await expect(page.locator('text=8.3%')).toHaveCount(0);

    // Permissions: approval queue fixture not displayed, and endpoint error renders role="alert"
    await page.goto('/manage?mode=live&page=permissions');
    await expect(page.locator('h1')).toContainText('权限控制面');
    const permAlert = page.locator('[role="alert"]');
    await expect(permAlert).toBeVisible();
    await expect(permAlert).toContainText('权限规则加载失败');
    await expect(page.locator('text=暂无数据')).not.toBeVisible();

    // 3. R-03 Verification on TracePage: getTraceRuns derives runs from /manage/runs with honest eventCount
    await page.goto('/manage?mode=live&page=trace');
    await expect(page.locator('h1')).toContainText('追踪');
    await expect(page.locator('[role="alert"]')).not.toBeVisible();
    const traceRun = page.locator('.traceRunItem:has-text("run_live_test_1")');
    await expect(traceRun).toBeVisible();
    await expect(traceRun).toHaveClass(/active/);
    await expect(traceRun).toContainText('未知');

    // Event timeline shows mocked event summary
    const timelineItem = page.locator('.timelineEventItem:has-text("Execute cargo check in workspace")');
    await expect(timelineItem).toBeVisible();

    // Raw Inspector shows the screened mocked payload on demand
    const inspector = page.locator('.traceInspector');
    await expect(inspector).toBeVisible();
    await inspector.getByRole('tab', { name: '原始' }).click();
    await expect(inspector).toContainText('原始证据未由接口上报');
    await expect(inspector).toContainText('cargo_check');
    await expect(inspector).toContainText('exitCode');
  });

  // 36. R-04: Settings unsupported controls are natively disabled with P3 目标 badges and 暂未支持配置 notices
  test('R-04: Settings unsupported controls are natively disabled with P3 目标 badges and 暂未支持配置 notices', async ({
    page,
  }) => {
    await page.goto('/manage?page=settings');
    await expect(page.locator('h1')).toContainText('系统设置');

    const unsupportedControlIds = [
      'setting-language',
      'setting-density',
      'setting-currency',
      'setting-pi-model',
      'setting-qq-activation',
      'setting-event-dedupe',
      'setting-sanitize',
      'setting-herdr-timeout',
      'setting-reconnect',
      'setting-notify-review',
      'setting-notify-auth',
    ];

    for (const id of unsupportedControlIds) {
      const el = page.locator(`#${id}`);
      await expect(el).toBeVisible();
      await expect(el).toBeDisabled();
      await expect(el).toHaveAttribute('aria-disabled', 'true');
    }

    // Supported controls remain interactive and functional
    const channelSelect = page.locator('#setting-channel-policy');
    await expect(channelSelect).toBeEnabled();
    await channelSelect.selectOption('owner_only');

    const pricingSelect = page.locator('#setting-unknown-price');
    await expect(pricingSelect).toBeEnabled();

    const retentionInput = page.locator('#setting-retention');
    await expect(retentionInput).toBeEnabled();

    // Dirty draft indicator appears
    await expect(page.locator('text=(有未保存草稿)')).toBeVisible();

    // Click Save
    await page.locator('button:has-text("保存设置草稿")').click();
    await expect(page.locator('[role="alert"]')).toContainText('[本地设计草稿]');
    await expect(page.locator('text=(有未保存草稿)')).not.toBeVisible();

    // Reload and verify persisted
    await page.reload();
    await expect(page.locator('#setting-channel-policy')).toHaveValue('owner_only');

    // Reset settings
    await page.locator('button:has-text("恢复默认设置")').click();
    await expect(page.locator('#setting-channel-policy')).toHaveValue('strict_allowlist');
  });

  // 37. R-05: Identity "以此主体测试 (模拟)" navigates to Permissions with testPrincipal pre-filled and preserved across reload
  test('R-05: Identity "以此主体测试 (模拟)" navigates to Permissions with testPrincipal pre-filled and preserved across reload', async ({
    page,
  }) => {
    await page.goto('/manage?page=identity');
    await expect(page.locator('h1')).toContainText('身份与访问');

    // Select worker_herdr_04 row
    const workerRow = page.locator('tr:has-text("worker_herdr_04")');
    await expect(workerRow).toBeVisible();
    await workerRow.click();

    // DetailRail opens with worker details
    const detailRail = page.locator('.detailRail');
    await expect(detailRail).toBeVisible();
    await expect(detailRail).toContainText('worker_herdr_04');

    // Click "以此主体测试 (模拟)"
    const simBtn = detailRail.locator('button:has-text("以此主体测试 (模拟)")');
    await expect(simBtn).toBeVisible();
    await simBtn.click();

    // Transitions to permissions page with testPrincipal param
    await expect(page).toHaveURL(/page=permissions.*testPrincipal=worker_herdr_04/);
    await expect(page.locator('h1')).toContainText('权限控制面');

    // Decision Tester's principal input should have worker_herdr_04
    const testerPrincipalInput = page.locator('#test-principal');
    await expect(testerPrincipalInput).toHaveValue('worker_herdr_04');

    // Reload and verify testPrincipal persists
    await page.reload();
    await expect(page).toHaveURL(/testPrincipal=worker_herdr_04/);
    await expect(page.locator('#test-principal')).toHaveValue('worker_herdr_04');

    // Execute simulation
    await page.locator('button:has-text("执行裁决模拟计算")').click();
    await expect(page.locator('text=模拟裁决结论 (客户端离线模拟)')).toBeVisible();

    // Navigate to another page via sidebar: testPrincipal is stripped
    const runsNav = page.locator('.sidebarNav button.navItem:has-text("运行记录")');
    await runsNav.click();
    await expect(page).toHaveURL(/page=runs/);
    expect(page.url()).not.toContain('testPrincipal');
  });

  // 38. R-10: Targeted navigation via attention queue, current run, ops trace button, and safe selection on invalid IDs
  test('R-10: Targeted navigation via attention queue, current run, ops trace button, and safe selection on invalid IDs', async ({
    page,
  }) => {
    // 1. Overview attention queue to Ops with task-221
    await page.goto('/manage?page=overview');
    await expect(page.locator('h1')).toContainText('概览');

    const task221Action = page.locator('.attentionItem:has-text("task-221") button:has-text("前往")');
    await expect(task221Action).toBeVisible();
    await task221Action.click();

    // Must navigate to ops with selectedId=task-221 and open task-221 detail
    await expect(page).toHaveURL(/page=ops.*selectedId=task-221/);
    await expect(page.locator('h1')).toContainText('任务协作');
    const opsDetailRail = page.locator('.detailRail');
    await expect(opsDetailRail).toBeVisible();
    await expect(opsDetailRail).toContainText('task-221');
    await expect(opsDetailRail).toContainText('NapCat OneBot 11 适配器重连容错验证');

    // In task-221 DetailRail, click Trace button (currentAttempt is run_A79)
    const traceBtn = opsDetailRail.locator('button:has-text("查看完整执行追踪")');
    await expect(traceBtn).toBeVisible();
    await traceBtn.click();

    // Must navigate to Trace with runId=run_A79 (NOT task ID, NOT stale attempt)
    await expect(page).toHaveURL(/page=trace.*runId=run_A79/);
    await expect(page.locator('h1')).toContainText('追踪');
    await expect(page.locator('.traceRunItem.active')).toContainText('run_A79');

    // 2. Overview attention queue to Permissions with perm-gate-03
    await page.goto('/manage?page=overview');
    const permGateAction = page.locator('.attentionItem:has-text("task-224") button:has-text("前往")');
    await expect(permGateAction).toBeVisible();
    await permGateAction.click();

    // Must navigate to permissions with selectedId=perm-gate-03
    await expect(page).toHaveURL(/page=permissions.*selectedId=perm-gate-03/);
    await expect(page.locator('h1')).toContainText('权限控制面');
    // Renders honest Notice about missing rule
    await expect(page.locator('text=未找到目标门禁规则 [perm-gate-03]')).toBeVisible();

    // 3. Overview current Run button navigates to Trace with overview.currentRun.id (run_A83)
    await page.goto('/manage?page=overview');
    const currentRunTraceBtn = page.locator('button:has-text("查看完整执行追踪 (Trace)")');
    await expect(currentRunTraceBtn).toBeVisible();
    await currentRunTraceBtn.click();

    await expect(page).toHaveURL(/page=trace.*runId=run_A83/);
    await expect(page.locator('.traceRunItem.active')).toContainText('run_A83');

    // Back button returns to Overview
    await page.goBack();
    await expect(page).toHaveURL(/page=overview/);

    // 4. Safe selection: invalid/foreign IDs fail safely and never fall back to index 0
    await page.goto('/manage?page=runs&runId=non-existent-run-999');
    await expect(page.locator('.detailRail')).toHaveCount(0);

    await page.goto('/manage?page=trace&runId=non-existent-run-999');
    await expect(page.locator('text=未找到指定的运行记录 [non-existent-run-999]')).toBeVisible();

    await page.goto('/manage?page=ops&selectedId=non-existent-task-999');
    await expect(page.locator('.detailRail')).toHaveCount(0);
  });

  // 39. R-06: Color-blind chart mode presentation styling and accessible table fallback
  test('R-06: Color-blind chart mode presentation styling and accessible table fallback', async ({
    page,
  }) => {
    await page.goto('/manage?page=monitor');
    await expect(page.locator('h1')).toContainText('系统监控');

    // Chart panel is rendered with SVG lines and points
    const chartPanel = page.locator('.chartPanel').first();
    await expect(chartPanel).toBeVisible();

    const chartLines = chartPanel.locator('polyline.chartLine');
    await expect(chartLines.first()).toBeVisible();
    const chartPoints = chartPanel.locator('circle.chartPoint');
    await expect(chartPoints.first()).toBeVisible();

    // Verify legend displays series with pattern indicators
    await expect(chartPanel.locator('.chartLegend')).toBeVisible();

    // Toggle table fallback view
    const toggleBtn = chartPanel.locator('button:has-text("表格视图")');
    await expect(toggleBtn).toBeVisible();
    await toggleBtn.click();

    // Data table is displayed in place of SVG (table mode renders no <svg> at all)
    await expect(chartPanel.locator('table.dataTable')).toBeVisible();
    await expect(chartPanel.locator('svg')).toHaveCount(0);

    // Toggle back to chart
    const chartViewBtn = chartPanel.locator('button:has-text("折线图")');
    await expect(chartViewBtn).toBeVisible();
    await chartViewBtn.click();
    await expect(chartPanel.locator('svg')).toBeVisible();

    // Go to settings and enable color-blind mode
    await page.goto('/manage?page=settings');
    const cbCheckbox = page.locator('#setting-colorblind');
    await expect(cbCheckbox).toBeVisible();
    await cbCheckbox.check();

    // Save draft
    await page.locator('button:has-text("保存设置草稿")').click();
    await expect(page.locator('[role="alert"]')).toContainText('[本地设计草稿]');

    // Navigate back to monitor page
    await page.goto('/manage?page=monitor');
    const appEl = page.locator('.managementApp');
    await expect(appEl).toHaveAttribute('data-colorblind', 'true');

    // In color-blind mode, .chartLine has stroke-width of 3px
    const strokeWidth = await page.evaluate(() => {
      const line = document.querySelector('.chartLine');
      return line ? window.getComputedStyle(line).strokeWidth : '';
    });
    expect(strokeWidth).toBe('3px');

    // Cleanup: restore color-blind setting
    await page.goto('/manage?page=settings');
    await page.locator('#setting-colorblind').uncheck();
    await page.locator('button:has-text("保存设置草稿")').click();
  });

  // 40. R-07: Trace timeline keyboard navigation, modifier guards, input focus isolation, and settings toggle
  test('R-07: Trace timeline keyboard navigation, modifier guards, input focus isolation, and settings toggle', async ({
    page,
  }) => {
    await page.goto('/manage?page=trace&runId=run_A83');
    await expect(page.locator('h1')).toContainText('追踪');

    // Verify initial active event is seq #1
    const activeEvent = page.locator('.timelineEventItem.active');
    await expect(activeEvent).toContainText('#1');

    // 1. Plain j advances to seq #2
    await page.keyboard.press('j');
    await expect(page.locator('.timelineEventItem.active')).toContainText('#2');

    // 2. Plain ArrowDown advances to seq #3
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.timelineEventItem.active')).toContainText('#3');

    // 3. Plain k goes back to seq #2
    await page.keyboard.press('k');
    await expect(page.locator('.timelineEventItem.active')).toContainText('#2');

    // 4. Plain ArrowUp goes back to seq #1
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('.timelineEventItem.active')).toContainText('#1');

    // 5. End jumps to the last event
    await page.keyboard.press('End');
    const lastEventText = await page.locator('.timelineEventItem').last().textContent();
    const activeText = await page.locator('.timelineEventItem.active').textContent();
    expect(activeText).toBe(lastEventText);

    // 6. Home jumps back to seq #1
    await page.keyboard.press('Home');
    await expect(page.locator('.timelineEventItem.active')).toContainText('#1');

    // 7. e expands and collapses the selected timeline event
    await page.keyboard.press('e');
    await expect(page.locator('.timelineEventItem.active')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.timelineEventItem.active .timelineEventExpanded')).toBeVisible();
    await page.keyboard.press('e');
    await expect(page.locator('.timelineEventItem.active')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.timelineEventItem.active .timelineEventExpanded')).toHaveCount(0);

    // 8. / focuses the search input
    await page.keyboard.press('/');
    const searchInput = page.locator('.timelineScrubber input[type="search"]');
    await expect(searchInput).toBeFocused();

    // 9. Typing in search input does NOT trigger trace keyboard navigation shortcuts
    await page.keyboard.type('j');
    await expect(searchInput).toHaveValue('j');

    // Clear search and blur input
    await searchInput.fill('');
    await page.locator('h1').click();

    // Event is still seq #1 (typing 'j' in input did not navigate to seq #2)
    await expect(page.locator('.timelineEventItem.active')).toContainText('#1');

    // 10. Modifier guard: Ctrl+K / Cmd+K opens Command Palette without altering active event
    await page.keyboard.press('Control+k');
    const cmdDialog = page.locator('[role="dialog"][aria-label="Command Palette"]');
    await expect(cmdDialog).toBeVisible();
    // Timeline event is still seq #1
    await expect(page.locator('.timelineEventItem.active')).toContainText('#1');
    await page.keyboard.press('Escape');
    await expect(cmdDialog).not.toBeVisible();

    // 11. Modifier guard: Ctrl+J is ignored
    await page.keyboard.press('Control+j');
    await expect(page.locator('.timelineEventItem.active')).toContainText('#1');

    // 12. Settings toggle: disable enableTraceKeyboardShortcuts
    await page.goto('/manage?page=settings');
    const shortcutsCb = page.locator('#setting-shortcuts');
    await shortcutsCb.uncheck();
    await page.locator('button:has-text("保存设置草稿")').click();

    // Return to trace and verify shortcuts are disabled
    await page.goto('/manage?page=trace&runId=run_A83');
    await expect(page.locator('.timelineEventItem.active')).toContainText('#1');
    await page.keyboard.press('j');
    // Still seq #1 because shortcuts are disabled
    await expect(page.locator('.timelineEventItem.active')).toContainText('#1');

    // Cleanup: re-enable shortcuts
    await page.goto('/manage?page=settings');
    await page.locator('#setting-shortcuts').check();
    await page.locator('button:has-text("保存设置草稿")').click();
  });

  // 41. R-08: Command Palette accessible combobox, active descendant navigation, Enter jump, and Escape focus restoration
  test('R-08: Command Palette accessible combobox, active descendant navigation, Enter jump, and Escape focus restoration', async ({
    page,
  }) => {
    await page.goto('/manage?page=overview');
    await expect(page.locator('h1')).toContainText('概览');

    // Focus an initiating control (e.g. sidebar nav button for Runs)
    const runsNavBtn = page.locator('.sidebarNav button.navItem:has-text("运行记录")');
    await runsNavBtn.focus();
    await expect(runsNavBtn).toBeFocused();

    // Open Command Palette via shortcut
    await page.keyboard.press('Control+k');
    const paletteDialog = page.locator('[role="dialog"][aria-label="Command Palette"]');
    await expect(paletteDialog).toBeVisible();

    // Verify ARIA combobox pattern attributes
    const cmdInput = paletteDialog.locator('input[role="combobox"]');
    await expect(cmdInput).toBeVisible();
    await expect(cmdInput).toBeFocused();
    await expect(cmdInput).toHaveAttribute('aria-expanded', 'true');
    await expect(cmdInput).toHaveAttribute('aria-haspopup', 'listbox');
    await expect(cmdInput).toHaveAttribute('aria-controls', 'cmd-palette-listbox');

    // Listbox container exists
    const listbox = paletteDialog.locator('#cmd-palette-listbox[role="listbox"]');
    await expect(listbox).toBeVisible();

    // First item is active by default
    await expect(cmdInput).toHaveAttribute('aria-activedescendant', 'cmd-item-overview');
    const overviewOption = listbox.locator('#cmd-item-overview');
    await expect(overviewOption).toHaveAttribute('role', 'option');
    await expect(overviewOption).toHaveAttribute('aria-selected', 'true');
    await expect(overviewOption).toHaveClass(/active/);

    // ArrowDown cycles to next option
    await page.keyboard.press('ArrowDown');
    await expect(cmdInput).toHaveAttribute('aria-activedescendant', 'cmd-item-conversations');
    const convOption = listbox.locator('#cmd-item-conversations');
    await expect(convOption).toHaveAttribute('aria-selected', 'true');
    await expect(convOption).toHaveClass(/active/);
    await expect(overviewOption).toHaveAttribute('aria-selected', 'false');

    // ArrowUp cycles back to first option
    await page.keyboard.press('ArrowUp');
    await expect(cmdInput).toHaveAttribute('aria-activedescendant', 'cmd-item-overview');

    // Query filters items and resets active index
    await cmdInput.fill('追踪');
    await expect(cmdInput).toHaveAttribute('aria-activedescendant', 'cmd-item-trace');
    const traceOption = listbox.locator('#cmd-item-trace');
    await expect(traceOption).toBeVisible();
    await expect(traceOption).toHaveAttribute('aria-selected', 'true');

    // Enter key navigates to the selected page and closes palette
    await page.keyboard.press('Enter');
    await expect(paletteDialog).not.toBeVisible();
    await expect(page).toHaveURL(/page=trace/);
    await expect(page.locator('h1')).toContainText('追踪');

    // Test Escape focus restoration
    const settingsNavBtn = page.locator('.sidebarNav button.navItem:has-text("设置")');
    await settingsNavBtn.focus();
    await expect(settingsNavBtn).toBeFocused();

    await page.keyboard.press('Control+k');
    await expect(paletteDialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(paletteDialog).not.toBeVisible();
    await expect(settingsNavBtn).toBeFocused();
  });

  // 42. R-09: Fail-closed live authentication prevents duplicate token verification on submit
  test('R-09: Fail-closed live authentication prevents duplicate token verification on submit', async ({
    page,
  }) => {
    let statusRequestCount = 0;
    await page.route('**/manage/status', (route) => {
      statusRequestCount++;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          service: 'glassbox',
          version: '0.0.0',
          status: 'ready',
          platform: 'linux',
          defaultExecution: 'claude-code',
          capabilities: {
            runs: true,
            trace: true,
          },
        }),
      });
    });

    await page.route('**/manage/models', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          profiles: [
            {
              id: 'claude-3-5-sonnet',
              label: 'Claude 3.5 Sonnet',
              protocol: 'anthropic-messages',
              baseUrl: 'https://api.anthropic.com',
              model: 'claude-3-5-sonnet-20241022',
              credentialConfigured: true,
            },
          ],
        }),
      });
    });

    // Navigate to live mode on PI page without stored token to isolate auth from Overview
    await page.goto('/manage?page=pi&mode=live');
    await expect(page.locator('#mgmt-token-input')).toBeVisible();

    // Submit valid 43-character token
    const testToken = '1234567890123456789012345678901234567890123';
    await page.locator('#mgmt-token-input').fill(testToken);
    await page.locator('button[type="submit"]').click();

    // Verify authorized content renders on PI page
    await expect(page.locator('.sidebarNav')).toBeVisible();
    await expect(page.locator('h1')).toContainText('PI');

    // Crucial check: exactly 1 status request occurred on form submission
    expect(statusRequestCount).toBe(1);

    // Verify raw token is never exposed in visible DOM
    await expect(page.locator(`text=${testToken}`)).not.toBeVisible();
  });

  // 43. R-11: DetailRail focus isolation on async data, explicit trigger return, and layered Escape preservation
  test('R-11: DetailRail focus isolation on async data, explicit trigger return, and layered Escape preservation', async ({
    page,
  }) => {
    // 1. Focus isolation on URL-driven direct load: DetailRail must NOT steal focus
    await page.goto('/manage?page=runs&runId=run_A83');
    const detailRail = page.locator('.detailRail');
    await expect(detailRail).toBeVisible();
    await expect(detailRail).toContainText('run_A83');
    // Rail must not have focus
    const isRailFocusedOnLoad = await page.evaluate(() => {
      return document.activeElement?.classList.contains('detailRail');
    });
    expect(isRailFocusedOnLoad).toBe(false);

    // 2. Explicit user click moves focus to DetailRail, and close restores focus to row
    await page.goto('/manage?page=runs');
    await expect(detailRail).not.toBeVisible();

    const runRow = page.locator('tr:has-text("run_A83")');
    await expect(runRow).toBeVisible();
    await runRow.click();

    // DetailRail opens and receives focus because of explicit user action
    await expect(detailRail).toBeVisible();
    await expect(detailRail).toBeFocused();

    // Press Escape to close DetailRail
    await page.keyboard.press('Escape');
    await expect(detailRail).not.toBeVisible();

    // Focus is restored to the initiating row
    await expect(runRow).toBeFocused();

    // 3. Layered Escape: Command Palette open over DetailRail closes ONLY Command Palette
    await runRow.click();
    await expect(detailRail).toBeVisible();

    // Open Command Palette over DetailRail
    await page.keyboard.press('Control+k');
    const cmdPalette = page.locator('[role="dialog"][aria-label="Command Palette"]');
    await expect(cmdPalette).toBeVisible();
    await expect(detailRail).toBeVisible();

    // First Escape closes ONLY Command Palette
    await page.keyboard.press('Escape');
    await expect(cmdPalette).not.toBeVisible();
    await expect(detailRail).toBeVisible();

    // Second Escape closes DetailRail
    await page.keyboard.press('Escape');
    await expect(detailRail).not.toBeVisible();
  });

  // 44. Live Trace: derives summaries from /manage/runs with honest 未知 event counts, fetches trace on selection, and supports deep link
  test('Live Trace derives summaries from /manage/runs with honest 未知 event counts, fetches trace on selection, and supports deep link', async ({
    page,
  }) => {
    const liveToken = 'valid_token_reviewer_0123456789_abcdefghijk';
    let requestedTraceRunId = null;

    await page.route('**/manage/status', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          service: 'glassbox',
          version: '0.8.4',
          status: 'ready',
          platform: 'linux',
          defaultExecution: 'pi',
          capabilities: { modelConfiguration: true, channels: true },
        }),
      });
    });

    await page.route('**/manage/runs', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          runs: [
            {
              id: 'run_custom_alpha',
              conversationId: 'conv_alpha',
              principalId: 'owner_primary',
              status: 'completed',
              modelId: 'claude-3-5-sonnet',
              durationMs: 1420,
              toolsExecutedCount: 4,
              artifacts: [],
              tokens: { prompt: 1000, completion: 200, total: 1200 },
              costUsd: null,
              costStatus: 'unknown',
              startedAt: '2026-09-18T14:00:00Z',
              traceId: 'trace-alpha',
              summary: 'Alpha custom live run',
            },
            {
              id: 'run_custom_beta',
              conversationId: 'conv_beta',
              principalId: 'worker_primary',
              status: 'running',
              modelId: 'gemini-pro',
              durationMs: 3500,
              toolsExecutedCount: 8,
              artifacts: [],
              tokens: { prompt: 3000, completion: 500, total: 3500 },
              costUsd: null,
              costStatus: 'unknown',
              startedAt: '2026-09-18T14:10:00Z',
              traceId: 'trace-beta',
              summary: 'Beta custom live run',
            },
          ],
        }),
      });
    });

    await page.route('**/manage/runs/*/trace', (route) => {
      const url = route.request().url();
      const match = url.match(/\/manage\/runs\/([^/]+)\/trace/);
      const runId = match ? decodeURIComponent(match[1]) : '';
      requestedTraceRunId = runId;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: `ev-${runId}-01`,
            runId: runId,
            sequence: 1,
            timestamp: '2026-09-18T14:10:05Z',
            type: 'tool',
            summary: `Tool execution in ${runId}`,
            payload: { executed: true, target: runId },
          },
        ]),
      });
    });

    await page.goto('/manage?mode=live');
    await page.locator('#mgmt-token-input').fill(liveToken);
    await page.locator('button[type="submit"]').click();

    await page.goto('/manage?mode=live&page=trace');
    await expect(page.locator('h1')).toContainText('追踪');

    const alphaItem = page.locator('.traceRunItem:has-text("run_custom_alpha")');
    const betaItem = page.locator('.traceRunItem:has-text("run_custom_beta")');
    await expect(alphaItem).toBeVisible();
    await expect(betaItem).toBeVisible();

    // Verify both show 未知 rather than 0
    await expect(alphaItem).toContainText('未知');
    await expect(alphaItem).not.toContainText('0 事件');
    await expect(betaItem).toContainText('未知');
    await expect(betaItem).not.toContainText('0 事件');

    // Selecting second run calls matching trace endpoint
    await betaItem.click();
    expect(requestedTraceRunId).toBe('run_custom_beta');
    await expect(page.locator('.timelineEventItem.active')).toContainText('Tool execution in run_custom_beta');
    const inspector = page.locator('.traceInspector');
    await expect(inspector).toContainText('run_custom_beta');
    await inspector.getByRole('tab', { name: '原始' }).click();
    await expect(inspector).toContainText('原始证据未由接口上报');
    await expect(inspector).toContainText('executed');

    // Deep link directly to valid runId
    await page.goto('/manage?mode=live&page=trace&runId=run_custom_beta');
    await expect(page.locator('.traceRunItem.active')).toContainText('run_custom_beta');
    await expect(page.locator('.timelineEventItem.active')).toContainText('Tool execution in run_custom_beta');
    await expect(page.locator('.traceInspector')).toContainText('run_custom_beta');
  });

  // 45. Live task truth: preserves state and attempt count, disabling Accept/Rework/Cancel with P3 explanation
  test('Live task truth preserves state and attempt count, disabling Accept/Rework/Cancel with P3 explanation', async ({
    page,
  }) => {
    const liveToken = 'valid_token_reviewer_0123456789_abcdefghijk';

    await page.route('**/manage/status', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          service: 'glassbox',
          version: '0.8.4',
          status: 'ready',
          platform: 'linux',
          defaultExecution: 'pi',
          capabilities: { modelConfiguration: true, channels: true },
        }),
      });
    });

    await page.route('**/manage/tasks', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          tasks: [
            {
              id: 'task_live_review_01',
              title: 'Review PR #42 Refactor',
              state: 'REVIEW',
              priority: 'high',
              creatorPrincipal: 'owner_primary',
              conversationId: 'conv_01',
              currentAttemptNo: 2,
              attempts: [
                {
                  attemptNo: 1,
                  status: 'REWORKED',
                  runId: 'run_old_01',
                  durationMs: 5000,
                  testResults: { passed: 10, total: 12 },
                },
                {
                  attemptNo: 2,
                  status: 'RUNNING',
                  runId: 'run_live_alpha',
                  durationMs: 8200,
                  testResults: { passed: 12, total: 12 },
                },
              ],
              herdrState: 'done',
              herdrObservationMeta: 'Worker reported done, awaiting human review',
              requiresReview: true,
              createdAt: '2026-09-18T10:00:00Z',
              updatedAt: '2026-09-18T11:00:00Z',
            },
          ],
        }),
      });
    });

    await page.goto('/manage?mode=live');
    await page.locator('#mgmt-token-input').fill(liveToken);
    await page.locator('button[type="submit"]').click();

    await page.goto('/manage?mode=live&page=ops');
    await expect(page.locator('h1')).toContainText('任务协作');

    const taskRow = page.locator('tr:has-text("task_live_review_01")');
    await expect(taskRow).toBeVisible();
    await taskRow.click();

    const detailRail = page.locator('.detailRail');
    await expect(detailRail).toBeVisible();
    await expect(detailRail).toContainText('task_live_review_01');
    await expect(detailRail).toContainText('REVIEW');

    // Verify Accept, Rework, Cancel buttons are disabled in live mode
    const acceptBtn = detailRail.locator('button:has-text("接受结果 (Accept)")');
    const reworkBtn = detailRail.locator('button:has-text("要求返工 (Rework)")');
    const cancelBtn = detailRail.locator('button:has-text("取消任务")');

    await expect(acceptBtn).toBeDisabled();
    await expect(reworkBtn).toBeDisabled();
    await expect(cancelBtn).toBeDisabled();

    // Verify P3 target explanation note
    await expect(detailRail).toContainText('P3 目标');
    await expect(detailRail).toContainText('任务变更接口暂不可用 (实时模式下禁止本地模拟变更任务真值)');

    // Verify state and attempt number remain unchanged
    await expect(detailRail).toContainText('第 #2 次尝试');
    await expect(taskRow).toContainText('REVIEW');
  });

  // 46. Overview chart truth: displays raw run-frequency values in table and tooltip, never plotScale multiples
  test('Overview chart displays raw run-frequency values in table and tooltip, never plotScale multiples', async ({
    page,
  }) => {
    await page.goto('/manage?page=overview');
    await expect(page.locator('h1')).toContainText('概览');

    const chartPanel = page.locator('.chartPanel');
    await expect(chartPanel).toBeVisible();

    // Switch to table view
    const tableBtn = chartPanel.locator('button:has-text("表格视图")');
    await expect(tableBtn).toBeVisible();
    await tableBtn.click();

    const dataTable = chartPanel.locator('table.dataTable');
    await expect(dataTable).toBeVisible();

    // Inspect row for 14:00 (52000 tokens, 34 runs)
    const row14 = dataTable.locator('tbody tr:has-text("14:00")');
    await expect(row14).toBeVisible();
    const cells14 = row14.locator('td');
    await expect(cells14.nth(1)).toHaveText('52000');
    await expect(cells14.nth(2)).toHaveText('34');

    // Inspect row for 13:00 (45000 tokens, 28 runs)
    const row13 = dataTable.locator('tbody tr:has-text("13:00")');
    await expect(row13).toBeVisible();
    const cells13 = row13.locator('td');
    await expect(cells13.nth(1)).toHaveText('45000');
    await expect(cells13.nth(2)).toHaveText('28');

    // Require raw values 34 and 28; forbid 34000 and 28000 in the run-frequency column
    const runFreqCells = dataTable.locator('tbody tr td:nth-child(3)');
    const runFreqTexts = await runFreqCells.allInnerTexts();
    expect(runFreqTexts).toContain('34');
    expect(runFreqTexts).toContain('28');
    expect(runFreqTexts).not.toContain('34000');
    expect(runFreqTexts).not.toContain('28000');

    // Switch back to line chart
    const chartBtn = chartPanel.locator('button:has-text("折线图")');
    await expect(chartBtn).toBeVisible();
    await chartBtn.click();
    await expect(chartPanel.locator('svg')).toBeVisible();

    // Hover the run-series circle at index 4 (14:00, value 34)
    // Series 0 has circles 0..5, series 1 has circles 6..11. Circle 10 corresponds to 14:00.
    const circles = chartPanel.locator('circle.chartPoint');
    await expect(circles.first()).toBeVisible();
    await circles.nth(10).hover();

    const tooltip = chartPanel.locator('.chartTooltip');
    await expect(tooltip).toBeVisible();
    const tooltipText = await tooltip.innerText();
    expect(tooltipText).toContain('14:00');
    expect(tooltipText).toContain('34');
    expect(tooltipText).not.toContain('34000');
  });

  // 47. DetailRail Escape: preserves rail when typing in input/select and closes when focus is outside
  test('DetailRail Escape preserves rail when typing in input or select and closes when focus is outside', async ({
    page,
  }) => {
    await page.goto('/manage?page=runs');
    await expect(page.locator('h1')).toContainText('运行记录');

    const runRow = page.locator('tr:has-text("run_A83")');
    await runRow.click();
    const detailRail = page.locator('.detailRail');
    await expect(detailRail).toBeVisible();

    // 1. Focus search input in FilterBar and press Escape -> Rail must REMAIN OPEN
    const searchInput = page.locator('input[placeholder="搜索运行 ID、摘要或模型..."]');
    await searchInput.focus();
    await page.keyboard.press('Escape');
    await expect(detailRail).toBeVisible();

    // 2. Focus filter select in FilterBar and press Escape -> Rail must REMAIN OPEN
    const statusSelect = page.locator('.filterBar select');
    await statusSelect.focus();
    await page.keyboard.press('Escape');
    await expect(detailRail).toBeVisible();

    // 3. Focus a non-editable element inside the rail (click DetailRail header) and press Escape -> Rail MUST CLOSE
    await page.locator('.detailRailHeader').click();
    await page.keyboard.press('Escape');
    await expect(detailRail).not.toBeVisible();
  });

  // 48. Live disconnect: clears both stores, fails closed, and keeps topbar controls collision-free across viewports
  test('Live disconnect clears both sessionStorage and localStorage, fails closed, and keeps topbar controls collision-free across viewports', async ({
    page,
  }) => {
    const liveToken = 'valid_token_reviewer_0123456789_abcdefghijk';

    await page.route('**/manage/status', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          service: 'glassbox',
          version: '0.8.4',
          status: 'ready',
          platform: 'linux',
          defaultExecution: 'pi',
          capabilities: { modelConfiguration: true, channels: true },
        }),
      });
    });

    await page.route('**/manage/models', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          profiles: [
            {
              id: 'claude-3-5-sonnet',
              label: 'Claude 3.5 Sonnet',
              protocol: 'anthropic',
              baseUrl: 'https://api.anthropic.com',
              model: 'claude-3-5-sonnet-20241022',
              credentialConfigured: true,
            },
          ],
        }),
      });
    });

    await page.route('**/manage/channels', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          channels: [],
        }),
      });
    });

    const viewportsToTest = [
      { width: 1440, height: 900, name: 'desktop' },
      { width: 390, height: 844, name: 'mobile-390' },
      { width: 320, height: 700, name: 'mobile-320' },
    ];

    for (const vp of viewportsToTest) {
      await page.setViewportSize({ width: vp.width, height: vp.height });

      await page.goto('/manage?mode=live');
      await page.evaluate(() => {
        sessionStorage.clear();
        localStorage.clear();
      });
      await page.reload();

      const tokenInput = page.locator('#mgmt-token-input');
      await expect(tokenInput).toBeVisible();
      await tokenInput.fill(liveToken);

      const persistCheckbox = page.locator('#persist-token');
      await expect(persistCheckbox).toBeVisible();
      await persistCheckbox.check();

      await page.locator('button[type="submit"]').click();

      // Verify authenticated view rendered
      await expect(page.locator('.repoMeta')).toBeVisible();

      // Verify both storage mechanisms have token
      const tokensBefore = await page.evaluate(() => ({
        session: sessionStorage.getItem('glassbox_management_token'),
        local: localStorage.getItem('glassbox_management_token'),
      }));
      expect(tokensBefore.session).toBe(liveToken);
      expect(tokensBefore.local).toBe(liveToken);

      // Verify topbar interactive controls rectangles have no overlap
      const topbarControls = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('.topbar button, .topbar a'));
        return buttons
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 0 && r.height > 0)
          .map((r) => ({
            left: Math.round(r.left),
            right: Math.round(r.right),
            top: Math.round(r.top),
            bottom: Math.round(r.bottom),
          }));
      });

      for (let i = 0; i < topbarControls.length; i++) {
        for (let j = i + 1; j < topbarControls.length; j++) {
          const a = topbarControls[i];
          const b = topbarControls[j];
          const overlaps = a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
          expect(overlaps, `Topbar controls at index ${i} and ${j} overlap at viewport ${vp.width}x${vp.height}`).toBe(false);
        }
      }

      // Check no page-level horizontal overflow
      const hasHorizontalScroll = await page.evaluate(() => {
        return document.documentElement.scrollWidth > document.documentElement.clientWidth;
      });
      expect(hasHorizontalScroll, `Horizontal scroll detected at viewport ${vp.width}x${vp.height}`).toBe(false);

      // Click disconnect
      const disconnectBtn = page.locator('button:has-text("断开凭据")');
      await expect(disconnectBtn).toBeVisible();
      await disconnectBtn.click();

      // Verify both storages cleared
      const tokensAfter = await page.evaluate(() => ({
        session: sessionStorage.getItem('glassbox_management_token'),
        local: localStorage.getItem('glassbox_management_token'),
      }));
      expect(tokensAfter.session).toBeNull();
      expect(tokensAfter.local).toBeNull();

      // Verify login prompt returns (fail closed)
      await expect(page.locator('#mgmt-token-input')).toBeVisible();
    }
  });

  // 49. Settings retention validation: enforces 7-365 range with inline alert, aria-invalid, and disabled Save
  test('Settings retention validation enforces 7-365 range with inline alert, aria-invalid, and disabled Save', async ({
    page,
  }) => {
    await page.goto('/manage?page=settings');
    await expect(page.locator('h1')).toContainText('系统设置');

    const retentionInput = page.locator('#setting-retention');
    const saveBtn = page.locator('button:has-text("保存设置草稿")');

    // 1. Enter 2 -> invalid (< 7)
    await retentionInput.fill('2');
    await expect(retentionInput).toHaveAttribute('aria-invalid', 'true');
    const describedBy2 = await retentionInput.getAttribute('aria-describedby');
    expect(describedBy2).toBeTruthy();
    const errorEl2 = page.locator(`#${describedBy2}`);
    await expect(errorEl2).toBeVisible();
    await expect(errorEl2).toContainText('7 至 365');
    await expect(saveBtn).toBeDisabled();

    // 2. Enter 500 -> invalid (> 365)
    await retentionInput.fill('500');
    await expect(retentionInput).toHaveAttribute('aria-invalid', 'true');
    const describedBy500 = await retentionInput.getAttribute('aria-describedby');
    const errorEl500 = page.locator(`#${describedBy500}`);
    await expect(errorEl500).toBeVisible();
    await expect(errorEl500).toContainText('7 至 365');
    await expect(saveBtn).toBeDisabled();

    // 3. Clear input -> invalid (blank)
    await retentionInput.fill('');
    await expect(retentionInput).toHaveAttribute('aria-invalid', 'true');
    const describedByBlank = await retentionInput.getAttribute('aria-describedby');
    const errorElBlank = page.locator(`#${describedByBlank}`);
    await expect(errorElBlank).toBeVisible();
    await expect(errorElBlank).toContainText('不能为空');
    await expect(saveBtn).toBeDisabled();
    // Must NOT silently reset to 30
    expect(await retentionInput.inputValue()).toBe('');

    // 4. Enter 7 -> valid boundary
    await retentionInput.fill('7');
    await expect(retentionInput).not.toHaveAttribute('aria-invalid', 'true');
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();
    await expect(page.locator('[role="alert"]')).toContainText('本地设计草稿');
    await page.locator('[role="alert"] button:has-text("确定")').click();

    // 5. Enter 365 -> valid boundary
    await retentionInput.fill('365');
    await expect(retentionInput).not.toHaveAttribute('aria-invalid', 'true');
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();
    await expect(page.locator('[role="alert"]')).toContainText('本地设计草稿');
  });

  // 50. Trace responsive layout: stacks vertically at 769, 820, 1024 and remains side-by-side at 1440
  test('Trace responsive layout stacks vertically at 769, 820, 1024 and remains side-by-side at 1440', async ({
    page,
  }) => {
    const responsiveWidths = [769, 820, 1024];

    for (const width of responsiveWidths) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/manage?page=trace');
      await expect(page.locator('h1')).toContainText('追踪');

      const layout = page.locator('.traceLayout');
      await expect(layout).toBeVisible();

      // Check stacked layout: flex-direction is column
      const flexDirection = await layout.evaluate((el) => window.getComputedStyle(el).flexDirection);
      expect(flexDirection).toBe('column');

      // Check bounding boxes of the 3 panels
      const runList = page.locator('.traceRunList');
      const timeline = page.locator('.traceTimeline');
      const inspector = page.locator('.traceInspector');

      await expect(runList).toBeVisible();
      await expect(timeline).toBeVisible();
      await expect(inspector).toBeVisible();

      const runListBox = await runList.boundingBox();
      const timelineBox = await timeline.boundingBox();
      const inspectorBox = await inspector.boundingBox();

      expect(runListBox).toBeTruthy();
      expect(timelineBox).toBeTruthy();
      expect(inspectorBox).toBeTruthy();

      // At widths 769, 820, and 1024, Run list, Timeline, and Inspector have positive dimensions
      expect(runListBox.width).toBeGreaterThan(0);
      expect(runListBox.height).toBeGreaterThan(0);
      expect(timelineBox.width).toBeGreaterThan(0);
      expect(timelineBox.height).toBeGreaterThan(0);
      expect(inspectorBox.width).toBeGreaterThan(0);
      expect(inspectorBox.height).toBeGreaterThan(0);

      // Their left and right edges stay within the document viewport or content area
      expect(runListBox.x).toBeGreaterThanOrEqual(0);
      expect(runListBox.x + runListBox.width).toBeLessThanOrEqual(width + 2);
      expect(timelineBox.x).toBeGreaterThanOrEqual(0);
      expect(timelineBox.x + timelineBox.width).toBeLessThanOrEqual(width + 2);
      expect(inspectorBox.x).toBeGreaterThanOrEqual(0);
      expect(inspectorBox.x + inspectorBox.width).toBeLessThanOrEqual(width + 2);

      // Run list precedes Timeline, and Timeline precedes Inspector (vertical stacking)
      expect(runListBox.y + runListBox.height).toBeLessThanOrEqual(timelineBox.y + 20);
      expect(timelineBox.y + timelineBox.height).toBeLessThanOrEqual(inspectorBox.y + 20);

      // Verify the timeline list has local vertical overflow when its event content exceeds the 320-pixel panel
      const timelineOverflow = await page.locator('.timelineList').evaluate((el) => {
        const style = window.getComputedStyle(el);
        return {
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          overflowY: style.overflowY,
        };
      });
      expect(['auto', 'scroll']).toContain(timelineOverflow.overflowY);
      expect(timelineOverflow.scrollHeight).toBeGreaterThan(timelineOverflow.clientHeight);

      // Scroll panels into view before interacting with their contents
      await runList.scrollIntoViewIfNeeded();
      const runItem = page.locator('.traceRunItem').first();
      await runItem.scrollIntoViewIfNeeded();
      await runItem.click();
      await expect(runItem).toHaveClass(/active/);

      await timeline.scrollIntoViewIfNeeded();
      const eventItem = page.locator('.timelineEventItem').first();
      await eventItem.scrollIntoViewIfNeeded();
      await eventItem.click();
      await expect(eventItem).toHaveClass(/active/);

      // Verify visible Inspector payload
      await inspector.scrollIntoViewIfNeeded();
      const inspectorContent = page.locator('.inspectorContent');
      await expect(inspectorContent).toBeVisible();
      const inspectorText = await inspectorContent.innerText();
      expect(inspectorText.length).toBeGreaterThan(0);
      expect(inspectorText).toContain('事件');
      expect(inspectorText).toContain('#1');
    }

    // At 1440x900: verify all three panels have positive, horizontally in-bounds rectangles and remain side by side
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/manage?page=trace');
    await expect(page.locator('h1')).toContainText('追踪');

    const desktopRunList = await page.locator('.traceRunList').boundingBox();
    const desktopTimeline = await page.locator('.traceTimeline').boundingBox();
    const desktopInspector = await page.locator('.traceInspector').boundingBox();

    expect(desktopRunList).toBeTruthy();
    expect(desktopTimeline).toBeTruthy();
    expect(desktopInspector).toBeTruthy();

    expect(desktopRunList.width).toBeGreaterThan(0);
    expect(desktopRunList.height).toBeGreaterThan(0);
    expect(desktopTimeline.width).toBeGreaterThan(0);
    expect(desktopTimeline.height).toBeGreaterThan(0);
    expect(desktopInspector.width).toBeGreaterThan(0);
    expect(desktopInspector.height).toBeGreaterThan(0);

    expect(desktopRunList.x).toBeGreaterThanOrEqual(0);
    expect(desktopInspector.x + desktopInspector.width).toBeLessThanOrEqual(1440 + 2);

    expect(desktopRunList.x + desktopRunList.width).toBeLessThanOrEqual(desktopTimeline.x + 20);
    expect(desktopTimeline.x + desktopTimeline.width).toBeLessThanOrEqual(desktopInspector.x + 20);
  });

  // 51. Settings labels: all label[for] resolve to valid labelable elements
  test('Settings page labels with htmlFor resolve to valid labelable elements', async ({
    page,
  }) => {
    await page.goto('/manage?page=settings');
    await expect(page.locator('h1')).toContainText('系统设置');

    const labelChecks = await page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll('label[for]'));
      const labelableTags = ['button', 'input', 'meter', 'output', 'progress', 'select', 'textarea'];
      return labels.map((label) => {
        const forId = label.getAttribute('for');
        const target = document.getElementById(forId);
        const control = label.control;
        return {
          forId,
          targetExists: Boolean(target),
          targetTag: target?.tagName.toLowerCase() || null,
          isLabelable: target ? labelableTags.includes(target.tagName.toLowerCase()) : false,
          hasControl: Boolean(control),
        };
      });
    });

    expect(labelChecks.length).toBeGreaterThan(0);
    for (const check of labelChecks) {
      expect(check.targetExists, `Target element #${check.forId} does not exist`).toBe(true);
      expect(check.isLabelable, `Element #${check.forId} with tag <${check.targetTag}> is not labelable`).toBe(true);
      expect(check.hasControl, `Label for #${check.forId} does not associate to a control`).toBe(true);
    }

    // Explicit check for setting-pi-profile
    const piProfileCheck = labelChecks.find((c) => c.forId === 'setting-pi-profile');
    expect(piProfileCheck).toBeDefined();
    expect(piProfileCheck?.isLabelable).toBe(true);
    expect(piProfileCheck?.targetTag).toBe('output');
  });

  // 52. Live Channels selection: synchronizes to custom channel IDs, preserves user choice on refresh, and avoids focus theft
  test('Live Channels selection synchronizes to custom channel IDs, preserves user choice on refresh, and avoids focus theft', async ({
    page,
  }) => {
    const liveToken = 'valid_token_reviewer_0123456789_abcdefghijk';

    // Install Playwright clock before navigation
    await page.clock.install();

    await page.route('**/manage/status', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          service: 'glassbox',
          version: '0.8.4',
          status: 'ready',
          platform: 'linux',
          defaultExecution: 'pi',
          capabilities: { modelConfiguration: true, channels: true },
        }),
      });
    });

    // Mock /manage/models before authentication to prevent 500 error from Vite proxy
    await page.route('**/manage/models', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          profiles: [
            {
              id: 'claude-3-5-sonnet',
              label: 'Claude 3.5 Sonnet',
              protocol: 'anthropic',
              baseUrl: 'https://api.anthropic.com',
              model: 'claude-3-5-sonnet-20241022',
              credentialConfigured: true,
            },
          ],
        }),
      });
    });

    let resolveSecondRequest;
    const secondRequestPromise = new Promise((resolve) => {
      resolveSecondRequest = resolve;
    });

    let channelRequestCount = 0;
    await page.route('**/manage/channels', (route) => {
      channelRequestCount++;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          channels: [
            {
              id: 'chan_custom_alpha',
              label: 'Alpha Gateway',
              kind: 'qq-onebot',
              endpoint: 'ws://127.0.0.1:5001',
              botId: 'bot-alpha',
              ownerId: 'owner-alpha',
              groupIds: ['grp-1'],
              tokenConfigured: true,
              autoConnect: true,
              connectionState: 'connected',
            },
            {
              id: 'chan_custom_beta',
              label: 'Beta Relay',
              kind: 'qq-onebot',
              endpoint: 'ws://127.0.0.1:5002',
              botId: 'bot-beta',
              ownerId: 'owner-beta',
              groupIds: ['grp-2'],
              tokenConfigured: true,
              autoConnect: true,
              connectionState: 'connected',
            },
          ],
        }),
      });
      if (channelRequestCount >= 2) {
        resolveSecondRequest();
      }
    });

    // Authenticate
    await page.goto('/manage?mode=live');
    await page.locator('#mgmt-token-input').fill(liveToken);
    await page.locator('button[type="submit"]').click();

    // Navigate to Channels through UI navigation link
    const channelsNavLink = page.locator('.sidebarNav button.navItem:has-text("渠道与集成")');
    await channelsNavLink.click();
    await expect(page.locator('h1')).toContainText('渠道与集成');

    // Verify first channel is selected automatically
    const detailRail = page.locator('.detailRail');
    await expect(detailRail).toBeVisible();
    await expect(detailRail).toContainText('chan_custom_alpha');

    // CRUCIAL: Asynchronous data arrival must NOT steal focus to DetailRail!
    const isRailFocused = await page.evaluate(() => {
      return document.activeElement?.classList.contains('detailRail');
    });
    expect(isRailFocused, 'DetailRail stole focus after async data load from sidebar click').toBe(false);

    // Explicitly click second channel
    const betaRow = page.locator('tr:has-text("chan_custom_beta")');
    await betaRow.click();
    await expect(detailRail).toContainText('chan_custom_beta');

    // Query refresh: advance virtual time by more than 30s staleTime and trigger reconnect refetch
    await page.clock.fastForward(35000);
    await page.evaluate(() => {
      window.dispatchEvent(new Event('offline'));
      window.dispatchEvent(new Event('online'));
    });
    await page.clock.runFor(100);
    await secondRequestPromise;

    // Assert at least two requests occurred and the DetailRail still shows chan_custom_beta
    expect(channelRequestCount).toBeGreaterThanOrEqual(2);
    await expect(detailRail).toContainText('chan_custom_beta');
  });

  // 53. Frozen Channels catalog: exactly 3 cards, QQ labeled P3 目标, Future Channels labeled 后续, zero 预留 text
  test('Frozen Channels catalog contains exactly 3 cards with QQ labeled P3 目标 and Future Channels labeled 后续, zero 预留 text', async ({
    page,
  }) => {
    await page.goto('/manage?page=channels');
    await expect(page.locator('h1')).toContainText('渠道与集成');

    const catalogCards = page.locator('[data-testid="channel-catalog-cards"] > div');
    await expect(catalogCards).toHaveCount(3);

    // Card 1: Workbench Web
    const card1 = catalogCards.nth(0);
    await expect(card1).toContainText('Workbench Web');
    await expect(card1).toContainText('已连接');

    // Card 2: QQ / NapCat / OneBot 11
    const card2 = catalogCards.nth(1);
    await expect(card2).toContainText('QQ / NapCat / OneBot 11');
    await expect(card2).toContainText('P3 目标');

    // Card 3: 未来扩展渠道 (Future Channels)
    const card3 = catalogCards.nth(2);
    await expect(card3).toContainText('未来扩展渠道');
    await expect(card3).toContainText('后续');

    // Entire page must not contain "预留" anywhere
    const pageContent = await page.locator('body').innerText();
    expect(pageContent).not.toContain('预留');
  });

  // 54. Live PI model configuration is read-only, guards handlers against mutation, and model select inspects parameters without mutating defaults
  test('Live PI model configuration is read-only, guards handlers against mutation, and model select inspects parameters without mutating defaults', async ({
    page,
  }) => {
    const liveToken = '1234567890123456789012345678901234567890123';
    let modelsPostCount = 0;

    await page.route('**/manage/status', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          service: 'glassbox',
          version: '0.0.0',
          status: 'ready',
          platform: 'linux',
          defaultExecution: 'claude-code',
          capabilities: {
            runs: true,
            trace: true,
          },
        }),
      });
    });

    await page.route('**/manage/models', (route) => {
      if (route.request().method() !== 'GET') {
        modelsPostCount++;
      }
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          profiles: [
            {
              id: 'claude-3-5-sonnet',
              label: 'Claude 3.5 Sonnet',
              protocol: 'anthropic-messages',
              baseUrl: 'https://api.anthropic.com',
              model: 'claude-3-5-sonnet-20241022',
              credentialConfigured: true,
            },
            {
              id: 'gpt-4o',
              label: 'GPT-4o',
              protocol: 'openai-chat',
              baseUrl: 'https://api.openai.com',
              model: 'gpt-4o-2024-08-06',
              credentialConfigured: true,
            },
          ],
        }),
      });
    });

    // Authenticate and navigate to PI in live mode
    await page.goto('/manage?page=pi&mode=live');
    await page.locator('#mgmt-token-input').fill(liveToken);
    await page.locator('button[type="submit"]').click();

    // Verify authorized content on PI page
    await expect(page.locator('h1')).toContainText('PI');
    await expect(page.locator('.repoMeta .capabilityBadge:has-text("实时接口 (/manage)")')).toBeVisible();

    // 1. Visible live notice
    const liveNotice = page.locator('div:has-text("远程 PI 执行核心与采样参数配置变更为 P3 目标，当前实时视图仅供审查（只读）。")');
    await expect(liveNotice.first()).toBeVisible();

    // 2. Models table: default model shows "当前默认" (disabled), non-default shows "只读 (P3)" and is disabled
    const claudeRow = page.locator('tr:has-text("Claude 3.5 Sonnet")');
    await expect(claudeRow).toBeVisible();
    const claudeBtn = claudeRow.locator('button');
    await expect(claudeBtn).toContainText('当前默认');
    await expect(claudeBtn).toBeDisabled();

    const gptRow = page.locator('tr:has-text("GPT-4o")');
    await expect(gptRow).toBeVisible();
    const gptBtn = gptRow.locator('button');
    await expect(gptBtn).toContainText('只读 (P3)');
    await expect(gptBtn).toBeDisabled();

    // 3. Sampling parameters form is read-only
    const tempInput = page.locator('#pi-temp');
    await expect(tempInput).toBeDisabled();
    await expect(tempInput).toHaveAttribute('readonly', '');

    const applyTempBtn = page.locator('button[aria-label="应用温度参数"]');
    await expect(applyTempBtn).toBeDisabled();
    await expect(applyTempBtn).toContainText('只读 (P3)');

    // 4. Model selector dropdown allows inspecting different models without mutating
    const modelSelect = page.locator('#pi-default-model');
    await expect(modelSelect).toBeVisible();
    await modelSelect.selectOption('gpt-4o');

    // Selection inspected in form
    await expect(modelSelect).toHaveValue('gpt-4o');
    // Default model in table remains Claude 3.5 Sonnet
    await expect(claudeBtn).toContainText('当前默认');
    // Zero write/mutation requests sent to server
    expect(modelsPostCount).toBe(0);
  });

  // 55. Live Settings loads from /manage/settings, renders read-only controls, and disables save/reset
  test('Live Settings loads from /manage/settings, renders read-only controls, and disables save and reset', async ({
    page,
  }) => {
    const liveToken = '1234567890123456789012345678901234567890123';
    let settingsRequestCount = 0;

    await page.route('**/manage/status', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          service: 'glassbox',
          version: '0.0.0',
          status: 'ready',
          platform: 'linux',
          defaultExecution: 'claude-code',
          capabilities: {
            runs: true,
            trace: true,
          },
        }),
      });
    });

    await page.route('**/manage/settings', (route) => {
      settingsRequestCount++;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          retentionDays: 45,
          unknownPricingDisplay: 'hide_cost',
          defaultChannelPolicy: 'owner_only',
          autoReviewOnWorkerDone: true,
          colorBlindMode: true,
          enableTraceKeyboardShortcuts: false,
          isLocalDraftDirty: false,
        }),
      });
    });

    // Authenticate and navigate to Settings in live mode
    await page.goto('/manage?page=settings&mode=live');
    await page.locator('#mgmt-token-input').fill(liveToken);
    await page.locator('button[type="submit"]').click();

    // Verify authorized content on Settings page
    await expect(page.locator('h1')).toContainText('系统设置');
    expect(settingsRequestCount).toBeGreaterThanOrEqual(1);

    // 1. Live pill & notice
    await expect(page.locator('.pageHeader .capabilityBadge:has-text("实时接口")')).toBeVisible();
    const liveNotice = page.locator('div:has-text("服务端系统设置持久化接口为 P3 目标。当前实时模式已加载只读服务端配置，禁止在本地模拟篡改或保存设置。")');
    await expect(liveNotice.first()).toBeVisible();

    // 2. Action buttons disabled with read-only badge
    const readonlyButtons = page.locator('.pageHeaderActions button:has-text("只读 (P3)")');
    await expect(readonlyButtons).toHaveCount(2);
    await expect(readonlyButtons.nth(0)).toBeDisabled();
    await expect(readonlyButtons.nth(1)).toBeDisabled();

    // 3. Form controls reflect server response and are all disabled / read-only
    const retentionInput = page.locator('#setting-retention');
    await expect(retentionInput).toHaveValue('45');
    await expect(retentionInput).toBeDisabled();
    await expect(retentionInput).toHaveAttribute('readonly', '');

    const pricingSelect = page.locator('#setting-unknown-price');
    await expect(pricingSelect).toHaveValue('hide_cost');
    await expect(pricingSelect).toBeDisabled();

    const policySelect = page.locator('#setting-channel-policy');
    await expect(policySelect).toHaveValue('owner_only');
    await expect(policySelect).toBeDisabled();

    const shortcutsCheckbox = page.locator('#setting-shortcuts');
    await expect(shortcutsCheckbox).not.toBeChecked();
    await expect(shortcutsCheckbox).toBeDisabled();

    const autoReviewCheckbox = page.locator('#setting-auto-review');
    await expect(autoReviewCheckbox).toBeChecked();
    await expect(autoReviewCheckbox).toBeDisabled();

    const colorBlindCheckbox = page.locator('#setting-colorblind');
    await expect(colorBlindCheckbox).toBeChecked();
    await expect(colorBlindCheckbox).toBeDisabled();
  });

  // 56. Live Settings fails closed with visible alert on server response error without falling back to design defaults
  test('Live Settings fails closed with visible alert on server response error without falling back to design defaults', async ({
    page,
  }) => {
    const liveToken = '1234567890123456789012345678901234567890123';

    await page.route('**/manage/status', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          service: 'glassbox',
          version: '0.0.0',
          status: 'ready',
          platform: 'linux',
          defaultExecution: 'claude-code',
          capabilities: {
            runs: true,
            trace: true,
          },
        }),
      });
    });

    // Return invalid settings payload to trigger validation error without logging browser network error
    await page.route('**/manage/settings', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ settings: 'invalid-structure' }),
      });
    });

    // Authenticate and navigate to Settings in live mode
    await page.goto('/manage?page=settings&mode=live');
    await page.locator('#mgmt-token-input').fill(liveToken);
    await page.locator('button[type="submit"]').click();

    // Verify authorized shell loads
    await expect(page.locator('.sidebarNav')).toBeVisible();

    // Verify fail-closed error alert rendered
    const alert = page.locator('[role="alert"]');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('设置数据加载失败');
    await expect(alert).toContainText('PayloadValidationError');

    // Verify settings form fields are NOT rendered
    await expect(page.locator('#setting-retention')).not.toBeVisible();
    await expect(page.locator('#setting-unknown-price')).not.toBeVisible();
    await expect(page.locator('button:has-text("保存设置草稿")')).not.toBeVisible();
  });
});
