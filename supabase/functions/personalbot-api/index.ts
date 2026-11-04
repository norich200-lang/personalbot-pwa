const PROJECT_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ALLOWED_ORIGINS = new Set([
  "https://norich200-lang.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
]);

type Json = Record<string, unknown>;

function keyFromEnv(name: string, legacyName: string): string {
  const raw = Deno.env.get(name);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const candidate = parsed.default ?? Object.values(parsed)[0];
      if (typeof candidate === "string") return candidate;
      if (candidate && typeof candidate === "object" && "api_key" in candidate) {
        const apiKey = (candidate as { api_key?: unknown }).api_key;
        if (typeof apiKey === "string") return apiKey;
      }
    } catch {
      // Some older function environments expose one key as a plain string.
      return raw;
    }
  }
  return Deno.env.get(legacyName) ?? "";
}

function serviceKey(): string {
  return keyFromEnv("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY");
}

function publishableKey(): string {
  return keyFromEnv("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY");
}

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Vary": "Origin",
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(data: unknown, status = 200, origin: string | null = null): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8" },
  });
}

function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function newLinkCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

async function authenticatedUser(request: Request): Promise<string | null> {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match || !PROJECT_URL || !publishableKey()) return null;
  const response = await fetch(`${PROJECT_URL}/auth/v1/user`, {
    headers: { apikey: publishableKey(), authorization: `Bearer ${match[1]}` },
  });
  if (!response.ok) return null;
  const user = await response.json() as { id?: unknown };
  return typeof user.id === "string" ? user.id : null;
}

async function rpc(args: Json): Promise<Json> {
  const secret = serviceKey();
  if (!PROJECT_URL || !secret) throw new Error("server_not_configured");
  const response = await fetch(`${PROJECT_URL}/rest/v1/rpc/personalbot_api`, {
    method: "POST",
    headers: {
      apikey: secret,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!response.ok) throw new Error(`database_${response.status}`);
  return await response.json() as Json;
}

async function readJson(request: Request): Promise<Json> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 1_000_000) throw new Error("request_too_large");
  const value = await request.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_json");
  return value as Json;
}

function asUuid(value: string | undefined): string | null {
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return null;
  return value;
}

async function pwaRoute(request: Request, origin: string | null, pathname: string): Promise<Response> {
  if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ error: "origin_not_allowed" }, 403, origin);
  const authUserId = await authenticatedUser(request);
  if (!authUserId) return json({ error: "unauthorized" }, 401, origin);
  const method = request.method.toUpperCase();

  if (pathname === "/me" && method === "GET") {
    const result = await rpc({ p_action: "linked", p_auth_user_id: authUserId });
    return json(result, 200, origin);
  }

  if (pathname === "/link-codes" && method === "POST") {
    const code = newLinkCode();
    const result = await rpc({
      p_action: "create_link_code",
      p_auth_user_id: authUserId,
      p_code_hash: await digest(code),
    });
    if (result.error) return json(result, 409, origin);
    return json({ code, bot_username: "GrishaLifeManagerBot", expires_in_seconds: 600 }, 201, origin);
  }

  if (pathname === "/tasks" && method === "GET") {
    const result = await rpc({ p_action: "list_tasks", p_auth_user_id: authUserId });
    if (result.error === "not_linked") return json(result, 409, origin);
    return json(result, 200, origin);
  }

  if (pathname === "/tasks" && method === "POST") {
    const body = await readJson(request);
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title || title.length > 200) return json({ error: "invalid_title" }, 400, origin);
    const result = await rpc({
      p_action: "create_task",
      p_auth_user_id: authUserId,
      p_task: {
        id: asUuid(typeof body.id === "string" ? body.id : undefined),
        title,
        description: typeof body.description === "string" ? body.description.slice(0, 4000) : null,
        created_at: typeof body.created_at === "string" ? body.created_at : undefined,
        status: body.status === "completed" ? "completed" : "open",
      },
    });
    if (result.error) return json(result, 409, origin);
    return json(result, 201, origin);
  }

  if (pathname === "/tasks/import" && method === "POST") {
    const body = await readJson(request);
    if (!Array.isArray(body.tasks) || body.tasks.length > 500) return json({ error: "invalid_import" }, 400, origin);
    const safeTasks = body.tasks.map((item) => {
      const task = item && typeof item === "object" ? item as Json : {};
      return {
        id: typeof task.id === "string" ? task.id : null,
        title: typeof task.title === "string" ? task.title : typeof task.name === "string" ? task.name : "",
        description: typeof task.description === "string" ? task.description.slice(0, 4000) : null,
        status: task.done === true || task.status === "completed" ? "completed" : "open",
        created_at: typeof task.created === "string" ? task.created : typeof task.created_at === "string" ? task.created_at : null,
      };
    });
    const result = await rpc({ p_action: "import_tasks", p_auth_user_id: authUserId, p_tasks: safeTasks });
    if (result.error === "not_linked") return json(result, 409, origin);
    return json(result, 200, origin);
  }

  const taskMatch = pathname.match(/^\/tasks\/([0-9a-f-]+)$/i);
  if (taskMatch && !asUuid(taskMatch[1])) return json({ error: "invalid_task_id" }, 400, origin);
  if (taskMatch && method === "PATCH") {
    const body = await readJson(request);
    if (body.status !== "open" && body.status !== "completed") return json({ error: "invalid_status" }, 400, origin);
    const result = await rpc({ p_action: "update_task", p_auth_user_id: authUserId, p_task_id: taskMatch[1], p_task: { status: body.status } });
    if (result.error) return json(result, result.error === "not_found" ? 404 : 409, origin);
    return json(result, 200, origin);
  }
  if (taskMatch && method === "DELETE") {
    const result = await rpc({ p_action: "archive_task", p_auth_user_id: authUserId, p_task_id: taskMatch[1] });
    if (result.error) return json(result, result.error === "not_found" ? 404 : 409, origin);
    return json(result, 200, origin);
  }
  return json({ error: "not_found" }, 404, origin);
}

async function telegramSend(chatId: number, text: string): Promise<void> {
  const token = Deno.env.get("BOT_TOKEN") ?? "";
  if (!token) throw new Error("bot_not_configured");
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3900), disable_web_page_preview: true }),
  });
  if (!response.ok) throw new Error("telegram_send_failed");
}

async function telegramRoute(request: Request): Promise<Response> {
  const expected = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
  const supplied = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!expected || !safeEqual(expected, supplied)) return new Response("unauthorized", { status: 401 });

  const update = await request.json() as {
    update_id?: number;
    message?: { text?: string; from?: { id?: number }; chat?: { id?: number; type?: string } };
  };
  const message = update.message;
  const telegramUserId = message?.from?.id;
  const chatId = message?.chat?.id;
  if (!Number.isSafeInteger(update.update_id) || !Number.isSafeInteger(telegramUserId) ||
      !Number.isSafeInteger(chatId) || message?.chat?.type !== "private") {
    return Response.json({ ok: true });
  }

  const claimed = await rpc({
    p_action: "claim_telegram_update",
    p_update_id: update.update_id,
    p_telegram_user_id: telegramUserId,
  });
  if (claimed.claimed !== true) return Response.json({ ok: true });

  const text = message?.text?.trim() ?? "";
  const command = text.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  if (!command) return Response.json({ ok: true });
  const action = command[1].toLowerCase();
  const argument = (command[2] ?? "").trim();
  let reply = "";

  if (action === "start" || action === "help") {
    reply = "Բարև։ PersonalBot-ի առաջադրանքները կառավարելու հրամաններ՝\n/tasks — բաց առաջադրանքների ցանկ\n/add վերնագիր — նոր առաջադրանք\n/done N — ավարտել N-րդը\n/delete N — արխիվացնել N-րդը\n/link ԿՈԴ — կապել PWA հաշիվը։ Կոդը ստացիր PWA-ում։";
  } else if (action === "link") {
    if (!/^[0-9a-f]{32}$/i.test(argument)) {
      reply = "Կոդը սխալ է։ Ստեղծիր նոր կապակցման կոդ PWA-ում և ուղարկիր /link ԿՈԴ։";
    } else {
      const result = await rpc({ p_action: "claim_link_code", p_telegram_user_id: telegramUserId, p_code_hash: await digest(argument.toUpperCase()) });
      reply = result.ok === true
        ? "PWA-ն հաջողությամբ կապվեց Telegram հաշվիդ։ Առաջադրանքները համաժամացվում են։"
        : result.error === "telegram_account_not_allowed"
        ? "Այս Telegram հաշիվը PersonalBot-ում ակտիվ օգտատեր չէ։"
        : result.error === "already_linked"
        ? "Այս Telegram հաշիվը կամ PWA հաշիվն արդեն կապակցված է։"
        : "Կոդը ժամկետանց է կամ անվավեր։ Ստեղծիր նոր կոդ PWA-ում։";
    }
  } else if (action === "tasks" || action === "list") {
    const result = await rpc({ p_action: "telegram_tasks", p_telegram_user_id: telegramUserId });
    if (result.error) reply = "Այս Telegram հաշվին PersonalBot մուտք չկա։";
    else {
      const tasks = Array.isArray(result.tasks) ? result.tasks as Array<{ title?: string }> : [];
      reply = tasks.length ? "Բաց առաջադրանքներ՝\n" + tasks.slice(0, 30).map((task, i) => `${i + 1}. ${task.title ?? "(առանց վերնագրի)"}`).join("\n") + "\n\nՕգտագործիր /done N կամ /delete N։" : "Բաց առաջադրանքներ չկան։ Ավելացրու՝ /add վերնագիր";
    }
  } else if (action === "add" || action === "new") {
    if (!argument || argument.length > 200) reply = "Գրիր կարճ վերնագիր՝ /add առաջադրանքի վերնագիր";
    else {
      const result = await rpc({ p_action: "telegram_add", p_telegram_user_id: telegramUserId, p_task: { title: argument } });
      reply = result.ok === true ? "Առաջադրանքն ավելացվեց։ Ցանկը՝ /tasks" : result.error === "unauthorized" ? "Այս Telegram հաշվին PersonalBot մուտք չկա։" : "Առաջադրանքը չավելացվեց։ Փորձիր կրկին։";
    }
  } else if (action === "done" || action === "delete" || action === "archive") {
    const number = Number(argument);
    const result = Number.isInteger(number) && number > 0
      ? await rpc({ p_action: action === "done" ? "telegram_done" : "telegram_archive", p_telegram_user_id: telegramUserId, p_task_number: number })
      : { error: "invalid_task_number" };
    reply = result.ok === true
      ? action === "done" ? "Առաջադրանքը նշվեց ավարտված։" : "Առաջադրանքն արխիվացվեց։"
      : result.error === "unauthorized" ? "Այս Telegram հաշվին PersonalBot մուտք չկա։"
      : result.error === "not_found" ? "Այդ համարով բաց առաջադրանք չկա։ Ցանկը թարմացնելու համար ուղարկիր /tasks։"
      : "Օգտագործիր /done N կամ /delete N՝ N-ը փոխարինելով առաջադրանքի համարով։";
  } else {
    reply = "Չճանաչված հրաման է։ Հրամանների ցանկը՝ /help";
  }

  await telegramSend(chatId, reply);
  return Response.json({ ok: true });
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("origin");
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/^.*\/personalbot-api(?=\/|$)/, "") || "/";

  if (request.method === "OPTIONS") {
    if (origin && !ALLOWED_ORIGINS.has(origin)) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  try {
    if (pathname === "/telegram-webhook" && request.method === "POST") return await telegramRoute(request);
    return await pwaRoute(request, origin, pathname);
  } catch (error) {
    // Do not log request bodies, bearer tokens, link codes, or Telegram updates.
    const message = error instanceof Error ? error.message : "internal_error";
    const status = message === "request_too_large" || message === "invalid_json" ? 400 : 500;
    return json({ error: status === 500 ? "internal_error" : message }, status, origin);
  }
});

