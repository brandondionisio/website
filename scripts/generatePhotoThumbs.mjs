import { readdirSync, statSync } from "fs";
import { join } from "path";
import { writePhotoThumbsForFile, REPO_ROOT } from "./lib/photoThumbs.mjs";

const photosDir = join(REPO_ROOT, "public", "photos");
const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif)$/i;

async function main() {
	const names = readdirSync(photosDir);
	for (const name of names) {
		if (name === "thumbs") continue;
		const full = join(photosDir, name);
		if (!statSync(full).isFile()) continue;
		if (!IMAGE_EXT.test(name)) continue;
		try {
			await writePhotoThumbsForFile(full);
		} catch (e) {
			console.warn("skip:", name, e?.message ?? e);
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
