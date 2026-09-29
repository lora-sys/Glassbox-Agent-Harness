import { expect, test } from "@playwright/test";

test("Playwright starts Web on the allowed 5173 origin", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  expect(new URL(page.url()).origin).toBe("http://localhost:5173");
  await expect(page).toHaveTitle("Glassbox");
});
