import { Container, Text } from "@earendil-works/pi-tui";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";

const BORDER = "\u2502 "; // │

const SPINNER_CHARS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinIndex = 0;
function nextSpinner(): string {
	return SPINNER_CHARS[spinIndex++ % SPINNER_CHARS.length];
}

function titleLine(label: string, detail: string, t: any, color: string): string {
	const border = t.fg(color, t.bold(BORDER));
	if (color === "error") {
		return border + t.fg(color, t.bold(label + " ")) + t.fg(color, detail);
	}
	if (color === "success") {
		return border + t.fg(color, t.bold(label + " ")) + detail;
	}
	return border + t.bold(label + " ") + detail;
}

function partialTitleLine(label: string, detail: string, t: any): string {
	return t.fg("dim", BORDER + nextSpinner() + " " + label + " " + truncateDetail(detail));
}

function addBorder(text: string, t: any, color?: string): string {
	const borderColor = color ? t.fg(color, BORDER) : t.fg("border", BORDER);
	return text.split("\n").map((l: string) => borderColor + l).join("\n");
}

const MAX_TITLE_LEN = 100;
const MAX_CONTENT_LINE_LEN = 80;

function truncateDetail(detail: string): string {
	const firstLine = detail.split("\n")[0] || "";
	if (firstLine.length <= MAX_TITLE_LEN) return firstLine;
	return firstLine.slice(0, MAX_TITLE_LEN - 1) + "…";
}

/** Ensure every line in text is at most maxLen characters, hard-break if needed */
function hardWrap(text: string, maxLen: number): string {
	return text.split("\n").map((line) => {
		if (line.length <= maxLen) return line;
		const chunks: string[] = [];
		for (let i = 0; i < line.length; i += maxLen) {
			chunks.push(line.slice(i, i + maxLen));
		}
		return chunks.join("\n");
	}).join("\n");
}

export default function (pi: any) {
	const cwd = process.cwd();

	function registerTool(tool: any, label: string, getDetail: (a: any) => string) {
		pi.registerTool({
			name: tool.name, label: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			renderShell: "self",
			execute(...args: any[]) { return tool.execute(...args); },
			renderCall() { return new Container(); },
			renderResult(r: any, o: any, t: any, c: any) {
				const detail = getDetail(c?.args || {});
				// Partial (in-progress): show spinner + any streamed text
				if (o.isPartial) {
					const streamed = r.content?.filter((x: any) => x?.type === "text").map((x: any) => x.text).join("") || "";
					if (!o.expanded || (!detail && !streamed)) {
						return new Text(partialTitleLine(label, detail, t), 0, 0);
					}
					const lines = [];
					if (detail) {
						lines.push(addBorder(t.bold(label + " ") + hardWrap(detail, MAX_CONTENT_LINE_LEN), t, "dim"));
					}
					if (streamed) {
						lines.push(addBorder(streamed, t, "dim"));
					}
					return new Text(lines.join("\n"), 0, 0);
				}
				const err = c?.isError || r?.isError;
				const color = err ? "error" : "success";
				if (!o.expanded) {
					const truncated = truncateDetail(detail);
					return new Text(titleLine(label, truncated, t, color), 0, 0);
				}
				const parts = r.content?.filter((c: any) => c?.type === "text").map((c: any) => c.text) || [];
				if (r.details?.diff) parts.push(r.details.diff);
				// Expanded: full detail + output, all lines use state color (dim/success/error)
				const contentLines = [];
				if (detail) {
					contentLines.push(addBorder(t.bold(label + " ") + hardWrap(detail, MAX_CONTENT_LINE_LEN), t, color));
				}
				contentLines.push(...parts.map((p: string) => addBorder(p, t, color)));
				return new Text(contentLines.join("\n"), 0, 0);
			},
		});
	}

	registerTool(createReadTool(cwd), "read", (a) => a.path || "");
	registerTool(createBashTool(cwd), "$", (a) => {
		const cmd = a.command || "";
		return cmd;
	});
	registerTool(createEditTool(cwd), "edit", (a) => a.path || "");
	registerTool(createWriteTool(cwd), "write", (a) => a.path || "");
}
