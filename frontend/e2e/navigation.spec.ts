import { expect, test, type Page } from "@playwright/test";

function captureBrowserErrors(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return { consoleErrors, pageErrors };
}

const mojibake = /鐑|鍐|浠诲姟|鏌ョ湅|鈥|锟斤拷|閻憒|閿熸枻鎷?/;

test("home redirects to runs and runs supports refresh", async ({ page }) => {
  const errors = captureBrowserErrors(page);
  const apiRequests: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/v1/")) apiRequests.push(request.url()); });
  await page.goto("/");
  await expect(page).toHaveURL(/\/runs$/);
  await expect(page.locator("h1").first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText(mojibake);
  const refresh = page.locator("button").filter({ hasText: /^刷新$/ });
  await expect(refresh).toBeEnabled();
  await expect.poll(() => apiRequests.some((url) => url.endsWith("/v1/runs"))).toBe(true);
  const response = page.waitForResponse((item) => item.url().endsWith("/v1/runs") && item.request().method() === "GET");
  await refresh.click();
  await response;
  await expect(refresh).toBeEnabled();
  expect(errors.pageErrors).toEqual([]);
  expect(errors.consoleErrors).toEqual([]);
});

test("experiences uses the real API and unknown routes show 404", async ({ page }) => {
  const errors = captureBrowserErrors(page);
  const experienceResponse = page.waitForResponse((item) => item.url().endsWith("/v1/experiences"));
  await page.goto("/experiences");
  await experienceResponse;
  await expect(page.locator("h1").first()).toBeVisible();
  await page.goto("/this-route-does-not-exist");
  await expect(page.locator(".state-panel").first()).toBeVisible();
  expect(errors.pageErrors).toEqual([]);
  expect(errors.consoleErrors).toEqual([]);
});

test("runs page supports direct refresh and real detail navigation when data exists", async ({ page }) => {
  const errors = captureBrowserErrors(page);
  await page.goto("/runs");
  await expect(page.locator("h1").first()).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\/runs$/);
  const detailLinks = page.locator('a[href="/runs/33333333-3333-4333-8333-333333333333"]');
  await expect(detailLinks).toBeVisible();
  await detailLinks.click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/i);
  await expect(page.getByText("MISSION CONTROL")).toBeVisible();
  await expect(page.getByRole("tab").first()).toBeVisible();
  const decisionItems = page.locator(".decision-item");
  await expect(decisionItems.first()).toBeVisible();
  await decisionItems.first().click();
  await expect(page.getByText("DECISION INSPECTOR")).toBeVisible();
  await expect(page.getByText("Source Event")).toBeVisible();
  await page.getByRole("tab").nth(1).click();
  await expect(page.locator("[data-testid=\"evidence-graph-node\"]").first()).toBeVisible();
  await page.getByRole("button", { name: "适应视图" }).click();
  await page.getByRole("button", { name: "重置视图" }).click();
  const evidenceNode = page.locator('[data-testid="evidence-graph-node"][data-entity-id="evidence:ev-fixture-1"]');
  await expect(evidenceNode).toBeVisible();
  await evidenceNode.click();
  await expect(page.getByText("GRAPH INSPECTOR")).toBeVisible();
  await expect(page.getByText(/关联决策/)).toBeVisible();
  await page.locator(".linked-decisions button").first().click();
  await expect(page.getByText("DECISION INSPECTOR")).toBeVisible();
  const viewGraph = page.getByRole("button", { name: "在证据图中查看" });
  await expect(viewGraph).toBeVisible();
  await viewGraph.click();
  await expect(page.getByText("GRAPH INSPECTOR")).toBeVisible();
  await page.getByRole("tab").nth(2).click();
  await expect(page.locator(".raw-event").first()).toBeVisible();
  await page.getByRole("tab").first().click();
  await page.reload();
  await expect(page.getByText("MISSION CONTROL")).toBeVisible();
  await page.locator('a[href="/runs"]').first().click();
  await expect(page).toHaveURL(/\/runs$/);
  expect(errors.pageErrors).toEqual([]);
  expect(errors.consoleErrors).toEqual([]);
});

test("invalid run shows a real error state with working retry", async ({ page }) => {
  const errors = captureBrowserErrors(page);
  await page.goto("/runs/not-a-real-run");
  await expect(page.locator(".state-panel").first()).toBeVisible();
  const retry = page.locator("button").filter({ hasText: /重试|重新加载/ }).first();
  const response = page.waitForResponse((item) => item.url().includes("/v1/runs/not-a-real-run"));
  await retry.click();
  await response;
  await expect(retry).toBeEnabled();
  expect(errors.pageErrors).toEqual([]);
  expect(errors.consoleErrors.every((message) => message.includes("404 (Not Found)"))).toBe(true);
});

test("running detail receives live policy, raw event and graph updates without reload", async ({ page }) => {
  const errors = captureBrowserErrors(page);
  await page.goto("/runs/44444444-4444-4444-8444-444444444444");
  await expect(page.locator('[data-realtime-state="live"]')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Live evidence arrived")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("动作被策略阻断")).toBeVisible();
  await page.getByRole("tab", { name: "证据图" }).click();
  await expect(page.locator('[data-testid="evidence-graph-node"][data-entity-id="evidence:live-evidence-1"]')).toBeVisible();
  await page.getByRole("tab", { name: "原始事件" }).click();
  await expect(page.locator(".raw-event").filter({ hasText: "finding.recorded" })).toBeVisible();
  expect(errors.pageErrors).toEqual([]);
  expect(errors.consoleErrors).toEqual([]);
});
