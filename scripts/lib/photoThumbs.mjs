import { mkdirSync } from "fs";
import { join, basename, dirname } from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, "..", "..");

/** Writes `public/photos/thumbs/{stem}.jpg` (max width 400px, EXIF-corrected). */
export async function writePhotoThumbsForFile(finalImagePath) {
	const stem = basename(finalImagePath).replace(/\.[^.]+$/, "");
	const outName = `${stem}.jpg`;
	const thumbsDir = join(REPO_ROOT, "public", "photos", "thumbs");
	mkdirSync(thumbsDir, { recursive: true });
	const outPath = join(thumbsDir, outName);

	await sharp(finalImagePath)
		.rotate()
		.resize({ width: 400, withoutEnlargement: true })
		.jpeg({ quality: 82, mozjpeg: true })
		.toFile(outPath);
}
