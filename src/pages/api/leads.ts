import { mkdir, appendFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { APIRoute } from "astro";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir   = join(__dirname, "../../../data");
const leadsFile = join(dataDir, "leads.csv");
const csvHeader = "fullName,email,phone,channels,monthlySpend,biggestBlocker,createdAt\n";

const toCsvValue = (v: string) => `"${v.replace(/"/g, '""')}"`;

const json = (status: number, body: Record<string, unknown>) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

export const POST: APIRoute = async ({ request }) => {
	try {
		const payload = await request.json();

		const fullName       = String(payload?.fullName       ?? "").trim();
		const email          = String(payload?.email          ?? "").trim().toLowerCase();
		const phone          = String(payload?.phone          ?? "").trim();
		const channels       = String(payload?.channels       ?? "").trim();
		const monthlySpend   = String(payload?.monthlySpend   ?? "").trim();
		const biggestBlocker = String(payload?.biggestBlocker ?? "").trim();

		if (!fullName || !email || !phone || !channels || !monthlySpend || !biggestBlocker) {
			return json(400, { ok: false, error: "Missing required fields." });
		}

		// fn / ln derivados do fullName server-side
		const nameParts = fullName.split(/\s+/);
		const firstName  = nameParts[0] ?? "";
		const lastName   = nameParts.slice(1).join(" ");

		// ── Salva no CSV ──────────────────────────────────────────────
		const createdAt = new Date().toISOString();
		const line = [
			toCsvValue(fullName),
			toCsvValue(email),
			toCsvValue(phone),
			toCsvValue(channels),
			toCsvValue(monthlySpend),
			toCsvValue(biggestBlocker),
			toCsvValue(createdAt),
		].join(",") + "\n";

		await mkdir(dataDir, { recursive: true });
		try { await access(leadsFile); }
		catch { await appendFile(leadsFile, csvHeader, "utf8"); }
		await appendFile(leadsFile, line, "utf8");

		// ── Encaminha para n8n (server-side → sem CORS) ───────────────
		const webhookUrl = import.meta.env.PUBLIC_WEBHOOK_URL;
		if (webhookUrl) {
			// IP real do cliente (Nginx injeta via proxy_set_header)
			const clientIp =
				request.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
				request.headers.get("x-real-ip") ||
				"";

			// Fire-and-forget — não bloqueia a resposta ao browser
			fetch(webhookUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					// Dados do formulário
					full_name:       fullName,
					first_name:      firstName,
					last_name:       lastName,
					email,
					phone,
					channels,
					monthly_spend:   monthlySpend,
					biggest_blocker: biggestBlocker,
					// Tracking (enviado pelo FormScript via payload mesclado)
					meta_event_id:         payload.meta_event_id         ?? "",
					meta_em:               payload.meta_em               ?? "",
					meta_ph:               payload.meta_ph               ?? "",
					meta_fn:               payload.meta_fn               ?? "",
					meta_ln:               payload.meta_ln               ?? "",
					meta_fbp:              payload.meta_fbp              ?? "",
					meta_fbc:              payload.meta_fbc              ?? "",
					meta_user_agent:       payload.meta_user_agent       ?? "",
					meta_event_source_url: payload.meta_event_source_url ?? "",
					submitted_at:          payload.submitted_at          ?? createdAt,
					marketing_consent:     payload.marketing_consent     ?? false,
					url_params:            payload.url_params            ?? {},
					// IP capturado server-side (mais confiável que client)
					client_ip_address: clientIp,
				}),
			}).catch((err) => console.error("[leads] n8n webhook failed:", err));
		}

		return json(200, { ok: true });
	} catch {
		return json(500, { ok: false, error: "Failed to store lead." });
	}
};
