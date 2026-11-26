const assert = require("node:assert/strict");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const puppeteer = require(process.env.BROWSER_PUPPETEER || "puppeteer");
const base = process.env.MIOT_TEST_BASE_URL || "http://127.0.0.1:30617";
(async () => {
  const auth = await (
    await fetch(base + "/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin" }),
    })
  ).json();
  const api = async (path, method = "GET", body) => {
    const response = await fetch(base + "/api/v1/jsplugin/miot/api" + path, {
      method,
      headers: {
        Authorization: "Bearer " + auth.access_token,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    assert.ok(response.ok && result.success !== false, JSON.stringify(result));
    return result.data ?? result;
  };
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewport({ width: 390, height: 740 });
  let stage = "boot";
  try {
    await page.goto(
      base +
        "/api/v1/jsplugin/miot/static/index.html?access_token=" +
        auth.access_token,
    );
    await page.waitForFunction(() =>
      document
        .getElementById("plugin-view")
        ?.shadowRoot?.querySelector(".library-heading"),
    );
    const reveal = async (handle) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const geometry = await handle.evaluate((element) => {
          const container = element.closest("scroll-view");
          if (!container) return null;
          const bounds = container.getBoundingClientRect(),
            rect = element.getBoundingClientRect();
          return {
            x: bounds.x + bounds.width / 2,
            y:
              Math.max(bounds.y, 0) +
              Math.min(bounds.height, innerHeight - bounds.y) / 3,
            center: rect.y + rect.height / 2,
            target:
              Math.max(bounds.y, 0) +
              Math.min(bounds.height, innerHeight - bounds.y) / 2,
            visible:
              rect.y >= Math.max(bounds.y, 0) &&
              rect.bottom <= Math.min(bounds.bottom, innerHeight),
          };
        });
        if (!geometry || geometry.visible) return;
        await page.mouse.move(geometry.x, geometry.y);
        await page.mouse.wheel({ deltaY: geometry.center - geometry.target });
        await new Promise((resolve) => setTimeout(resolve, 180));
      }
    };
    const click = async (selector, label, index = 0) => {
      await page.waitForFunction(
        ({ selector, label }) =>
          [
            ...document
              .getElementById("plugin-view")
              .shadowRoot.querySelectorAll(selector),
          ].some(
            (e) =>
              e.getBoundingClientRect().height > 0 &&
              (!label ||
                e.textContent.trim() === label ||
                e.textContent.includes(label) ||
                e.getAttribute("accessibility-label") === label ||
                e.closest(".schedule-task-row")?.textContent.includes(label)),
          ),
        {},
        { selector, label },
      );
      const handle = await page.evaluateHandle(
        ({ selector, label, index }) => {
          const root = document.getElementById("plugin-view").shadowRoot;
          const candidates = [...root.querySelectorAll(selector)].filter(
            (element) => element.getBoundingClientRect().height > 0,
          );
          const element = label
            ? candidates.filter(
                (element) =>
                  element.textContent.trim() === label ||
                  element.textContent.includes(label) ||
                  element.getAttribute("accessibility-label") === label ||
                  element
                    .closest(".schedule-task-row")
                    ?.textContent.includes(label),
              )[index]
            : candidates[index];
          if (!element) throw new Error("missing: " + selector + " " + label);
          return element;
        },
        { selector, label, index },
      );
      await reveal(handle.asElement());
      const box = await handle.asElement().boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await handle.dispose();
      await new Promise((resolve) => setTimeout(resolve, 120));
    };
    const fill = async (label, value) => {
      await page.waitForFunction(
        (label) => {
          const root = document.getElementById("plugin-view").shadowRoot;
          return [...root.querySelectorAll(".settings-panel")]
            .filter((panel) => panel.getBoundingClientRect().height > 0)
            .some((panel) =>
              [...panel.querySelectorAll(".field, .chat-field")].some(
                (field) =>
                  field.textContent.trim().startsWith(label) &&
                  field.querySelector(".sl-input, .sl-textarea"),
              ),
            );
        },
        {},
        label,
      );
      const handle = await page.evaluateHandle((label) => {
        const root = document.getElementById("plugin-view").shadowRoot;
        const panel = [...root.querySelectorAll(".settings-panel")].find(
          (panel) => panel.getBoundingClientRect().height > 0,
        );
        const field = [...panel.querySelectorAll(".field, .chat-field")].find(
          (field) => field.textContent.trim().startsWith(label),
        );
        if (!field) throw new Error("missing input: " + label);
        return field;
      }, label);
      await page.waitForFunction(
        (field) => {
          const element = field.querySelector(".sl-input, .sl-textarea");
          const input =
            element?.shadowRoot?.querySelector("input, textarea") || element;
          return input && !input.readOnly;
        },
        {},
        handle,
      );
      await reveal(handle.asElement());
      const rect = await handle.evaluate((field) => {
        const element = field.querySelector(".sl-input, .sl-textarea");
        if (!element) throw new Error("input not mounted");
        const input =
          element.shadowRoot?.querySelector("input, textarea") || element;
        const rect = input.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      });
      await handle.dispose();
      await page.mouse.click(rect.x, rect.y);
      await page.keyboard.down("Control");
      await page.keyboard.press("A");
      await page.keyboard.up("Control");
      await page.keyboard.type(value);
      await new Promise((resolve) => setTimeout(resolve, 100));
    };
    const select = async (label, option) => {
      await page.waitForFunction(
        (label) => {
          const root = document.getElementById("plugin-view").shadowRoot;
          return [...root.querySelectorAll(".settings-panel")]
            .filter((panel) => panel.getBoundingClientRect().height > 0)
            .some((panel) =>
              [...panel.querySelectorAll(".field")].some(
                (field) =>
                  field.textContent.trim().startsWith(label) &&
                  field.querySelector(".sl-select"),
              ),
            );
        },
        {},
        label,
      );
      const handle = await page.evaluateHandle((label) => {
        const root = document.getElementById("plugin-view").shadowRoot;
        const panel = [...root.querySelectorAll(".settings-panel")].find(
          (panel) => panel.getBoundingClientRect().height > 0,
        );
        const field = [...panel.querySelectorAll(".field")].find((field) =>
          field.textContent.trim().startsWith(label),
        );
        const element = field?.querySelector(".sl-select");
        if (!element) throw new Error("missing select: " + label);
        return element;
      }, label);
      await reveal(handle.asElement());
      const box = await handle.asElement().boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await handle.dispose();
      await page.waitForFunction(
        () =>
          document
            .getElementById("plugin-view")
            .shadowRoot.querySelector(".select-option"),
        { timeout: 3000 },
      );
      if (option) await click(".select-option", option);
    };
    const taskName = "Lynx browser " + Date.now();
    const editedName = taskName + " edited";
    const dayButtons = ".schedule-editor .day-grid > *";
    const checkSelectedDays = async (step, expected) => {
      stage = step;
      await page.waitForFunction(
        ({ selector, expected }) => {
          const root = document.getElementById("plugin-view").shadowRoot;
          const save = root.querySelector(
            '.schedule-editor [accessibility-label="保存任务"]',
          );
          const selectedColor = getComputedStyle(save).backgroundColor;
          const days = [...root.querySelectorAll(selector)]
            .filter(
              (day) => getComputedStyle(day).backgroundColor === selectedColor,
            )
            .map((day) => day.textContent.trim());
          return (
            days.length === expected.length &&
            days.every((day, index) => day === expected[index])
          );
        },
        { timeout: 2000 },
        { selector: dayButtons, expected },
      );
    };
    stage = "schedule create";
    await page.waitForFunction(() =>
      document
        .getElementById("plugin-view")
        ?.shadowRoot?.querySelector(
          '.sl-button[accessibility-label="设置"]:not(.disabled)',
        ),
    );
    await click(".library-heading .sl-button", "设置");
    await click(".category", "定时");
    await click(".sl-button", "新建任务");
    await fill("任务名称", taskName);
    await select("动作", "关闭对话监听");
    await checkSelectedDays("new task defaults", ["一", "二", "三", "四", "五"]);
    await click(".sl-button", "每天");
    await checkSelectedDays("every day", [
      "一", "二", "三", "四", "五", "六", "日",
    ]);
    await click(".sl-button", "工作日");
    await checkSelectedDays("workdays", ["一", "二", "三", "四", "五"]);
    await click(dayButtons, "一");
    await click(dayButtons, "日");
    await checkSelectedDays("manual weekdays", ["二", "三", "四", "五", "日"]);
    let saved = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/schedules") &&
        response.request().method() === "POST",
    );
    await click(".sl-button", "保存任务");
    await saved;
    let tasks = (await api("/schedules")).tasks;
    let task = tasks.find((task) => task.name === taskName);
    assert.ok(task);
    const taskId = task.id;
    assert.equal(task.action, "disable_monitor");
    assert.deepEqual(task.params, {});
    assert.deepEqual([...task.schedule.weekdays].sort(), [0, 2, 3, 4, 5]);
    stage = "schedule update";
    await click(".schedule-task-row .sl-button", taskName, 0);
    await checkSelectedDays("reopened task", ["二", "三", "四", "五", "日"]);
    await fill("任务名称", editedName);
    await click(".sl-button", "工作日");
    await checkSelectedDays("workdays override manual selection", [
      "一", "二", "三", "四", "五",
    ]);
    saved = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/schedules/update") &&
        response.request().method() === "POST",
    );
    await click(".sl-button", "保存任务");
    await saved;
    tasks = (await api("/schedules")).tasks;
    task = tasks.find((item) => item.id === taskId);
    assert.equal(task.name, editedName);
    assert.deepEqual(task.schedule.weekdays, [1, 2, 3, 4, 5]);
    stage = "monthly selection";
    await click(".schedule-task-row .sl-button", editedName, 0);
    await select("调度类型", "每月");
    await click(dayButtons, "15");
    await checkSelectedDays("manual monthly date", ["15"]);
    await click(".sl-button", "取消");
    stage = "schedule delete";
    await click(".schedule-task-row .sl-button", taskName, 1);
    saved = page.waitForResponse(
      (response) =>
        response.url().includes("/api/schedules?") &&
        response.request().method() === "DELETE",
    );
    await click(".modal-card .sl-button", "删除");
    await saved;
    assert.ok(
      !(await api("/schedules")).tasks.some((item) => item.id === task.id),
    );
    stage = "multiline AI config";
    await click(".page-toolbar .sl-button");
    await click(".category", "AI 设置");
    await page.waitForFunction(
      () =>
        [
          ...document
            .getElementById("plugin-view")
            .shadowRoot.querySelectorAll(".chat-save .sl-button"),
        ].length > 0,
    );
    await click(".disclosure-heading", "连接方式、自定义请求头");
    const original = await api("/chat/config");
    const prompt = "你是测试助手。\n请保留这行换行。";
    await fill("角色提示词", prompt);
    saved = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/chat/config") &&
        response.request().method() === "PUT",
    );
    await click(".chat-save .sl-button", "保存设置");
    await saved;
    assert.equal((await api("/chat/config")).system_prompt, prompt);
    await api("/chat/config", "PUT", { system_prompt: original.system_prompt });
    stage = "host back layers";
    await click(".page-toolbar .sl-button");
    await click(".category", "定时");
    await click(".sl-button", "新建任务");
    await select("动作");
    await page.evaluate(() => {
      window.backResults = [];
      window.addEventListener("message", (event) => {
        try {
          const data =
            typeof event.data === "string"
              ? JSON.parse(event.data)
              : event.data;
          if (data?.type === "songloft-back-result")
            window.backResults.push(data);
        } catch {}
      });
      document.dispatchEvent(
        new CustomEvent("songloft-back-connect", {
          detail: { type: "songloft-back-connect", session: "browser-session" },
        }),
      );
    });
    const back = async (id) => {
      await page.evaluate(
        (id) =>
          document.dispatchEvent(
            new CustomEvent("songloft-back-request", {
              detail: {
                type: "songloft-back-request",
                session: "browser-session",
                id,
              },
            }),
          ),
        id,
      );
      await page.waitForFunction(
        (id) => window.backResults.some((result) => result.id === id),
        {},
        id,
      );
      assert.equal(
        await page.evaluate(
          (id) =>
            window.backResults.find((result) => result.id === id).consumed,
          id,
        ),
        true,
      );
    };
    await back(1);
    await page.waitForFunction(
      () =>
        document
          .getElementById("plugin-view")
          .shadowRoot.querySelectorAll(".modal-mask").length === 0,
    );
    await back(2);
    await page.waitForFunction(
      () =>
        !document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".schedule-editor")
          ?.getBoundingClientRect().height,
    );
    await back(3);
    await back(4);
    await page.waitForFunction(
      () =>
        document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".library-heading")
          .getBoundingClientRect().height > 0,
    );
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        passed: true,
        schedule: ["create", "update", "delete"],
        scheduleSelection: true,
        multiline: true,
        backLayers: 4,
      }),
    );
  } catch (error) {
    console.error("stage:", stage, "page errors:", errors);
    await page
      .screenshot({ path: join(tmpdir(), "miot-interaction-failure.png") })
      .catch(console.error);
    throw error;
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
