import { createServer } from "http";
import { createWriteStream, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import { google } from "googleapis";
import sharp from "sharp";
import { writePhotoThumbsForFile } from "./lib/photoThumbs.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function loadEnv() {
	const path = join(ROOT, ".env");
	try {
		const content = readFileSync(path, "utf8");
		const env = {};
		for (const line of content.split("\n")) {
			const i = line.indexOf("=");
			if (i > 0) {
				const key = line.slice(0, i).trim();
				const val = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
				env[key] = val;
			}
		}
		return env;
	} catch {
		return {};
	}
}

function saveRefreshToken(refreshToken) {
	const path = join(ROOT, ".env");
	let content = "";
	try {
		content = readFileSync(path, "utf8");
	} catch { }
	if (content.includes("GCP_REFRESH_TOKEN=")) {
		content = content.replace(/GCP_REFRESH_TOKEN=.*/, `GCP_REFRESH_TOKEN=${refreshToken}`);
	} else {
		content = content.trimEnd() + "\nGCP_REFRESH_TOKEN=" + refreshToken + "\n";
	}
	writeFileSync(path, content);
}

const env = loadEnv();
const CLIENT_ID = env.GCP_CLIENT_ID;
const CLIENT_SECRET = env.GCP_CLIENT_SECRET;
const REFRESH_TOKEN = env.GCP_REFRESH_TOKEN;
const FOLDER_ID = env.DRIVE_FOLDER_ID;

const REDIRECT_URI = "http://localhost:3333/callback";
const SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

function authViaBrowser() {
	return new Promise((resolve, reject) => {
		const authUrl = oauth2Client.generateAuthUrl({
			access_type: "offline",
			prompt: "consent",
			scope: SCOPES,
		});
		const server = createServer(async (req, res) => {
			const url = new URL(req.url, REDIRECT_URI);
			if (url.pathname !== "/callback") {
				res.writeHead(404).end();
				return;
			}
			const code = url.searchParams.get("code");
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(
				"<script>window.close()</script><p>Signed in.</p>"
			);
			server.close();
			if (!code) return reject(new Error("No code in callback"));
			try {
				const { tokens } = await oauth2Client.getToken(code);
				oauth2Client.setCredentials(tokens);
				if (tokens.refresh_token) saveRefreshToken(tokens.refresh_token);
				resolve();
			} catch (e) {
				reject(e);
			}
		});
		server.listen(3333, () => {
			console.log("Open this URL to sign in:\n", authUrl);
			const start =
				process.platform === "darwin"
					? "open"
					: process.platform === "win32"
						? "start"
						: "xdg-open";
			exec(`${start} "${authUrl}"`, () => { });
		});
	});
}

async function listAndDownload() {
	oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
	const drive = google.drive({ version: "v3", auth: oauth2Client });

	const outDir = join(ROOT, "public", "photos");
	mkdirSync(outDir, { recursive: true });

	const res = await drive.files.list({
		q: `'${FOLDER_ID}' in parents and trashed = false`,
		fields: "files(id, name, mimeType, createdTime)",
		orderBy: "name",
	});

	const ALLOWED_MIMES = ["image/jpeg", "image/png", "image/heic", "image/heif"];
	const files = (res.data.files || []).filter((f) =>
		ALLOWED_MIMES.includes((f.mimeType || "").toLowerCase())
	);

	function parseDateFromName(name) {
		const base = name.replace(/\.[^.]+$/, "");
		const m = base.match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);
		if (!m) return null;
		const [, month, day, year] = m;
		return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
	}

	const dailyPhotos = [];

	const mimeToExt = {
		"image/jpeg": "jpg",
		"image/png": "png",
		"image/heic": "heic",
		"image/heif": "heif",
	};

	for (const file of files) {
		const dateStr = parseDateFromName(file.name) ?? (file.createdTime ? file.createdTime.slice(0, 10) : null);
		if (!dateStr) continue;

		const ext = mimeToExt[(file.mimeType || "").toLowerCase()] ?? (file.name.includes(".") ? file.name.replace(/^.*\./, "") : "jpg");
		let safeName = `${dateStr}.${ext}`;
		let finalPath = join(outDir, safeName);

		const response = await drive.files.get(
			{ fileId: file.id, alt: "media" },
			{ responseType: "stream" }
		);
		const dest = createWriteStream(finalPath);
		await new Promise((resolve, reject) => {
			response.data.pipe(dest);
			response.data.on("end", resolve);
			response.data.on("error", reject);
		});

		if (ext === "heic" || ext === "heif") {
			try {
				const jpgPath = join(outDir, `${dateStr}.jpg`);
				await sharp(finalPath)
					.jpeg({ quality: 90 })
					.toFile(jpgPath);
				unlinkSync(finalPath);
				safeName = `${dateStr}.jpg`;
				finalPath = jpgPath;
			} catch (err) {
				console.warn("HEIC convert failed:", err.message);
			}
		}

		try {
			await writePhotoThumbsForFile(finalPath);
		} catch (err) {
			console.warn("Thumb generation failed:", safeName, err?.message ?? err);
		}

		const nameWithoutExt = file.name.replace(/\.[^.]+$/, "");
		const altPart = nameWithoutExt
			.replace(/^\d{1,2}-\d{1,2}-\d{4}[-.\s]*/, "")
			.replace(/^[.\s-]+/, "")
			.trim();
		dailyPhotos.push({
			date: dateStr,
			src: `/photos/${safeName}`,
			alt: altPart || undefined,
		});
	}

	dailyPhotos.sort((a, b) => a.date.localeCompare(b.date));

	writeFileSync(join(ROOT, "src", "data", "dailyPhotos.json"), JSON.stringify(dailyPhotos, null, 2), "utf8");
}

async function main() {
	if (!CLIENT_ID || !CLIENT_SECRET) {
		console.error("Missing GCP_CLIENT_ID or GCP_CLIENT_SECRET in .env");
		process.exit(1);
	}
	if (!FOLDER_ID) {
		console.error(
			"Missing DRIVE_FOLDER_ID in .env."
		);
		process.exit(1);
	}

	if (!REFRESH_TOKEN) {
		await authViaBrowser();
		console.log("Run npm run photos:sync one more time to sync.");
		return;
	}

	try {
		await listAndDownload();
	} catch (err) {
		const oauthErr = err?.response?.data?.error;
		if (oauthErr !== "invalid_grant") throw err;

		const isCI = Boolean(process.env.GITHUB_ACTIONS) || Boolean(process.env.CI);
		if (isCI) {
			throw err;
		}

		console.warn("Refresh token is invalid and re-running auth");
		await authViaBrowser();
		await listAndDownload();
	}
}

main().catch((err) => {
	if (err?.response?.data?.error === "invalid_grant") {
		console.error("invalid grant, GCP_REFRESH_TOKEN expired or revoked");
	} else {
		console.error(err);
	}
	process.exit(1);
});
