import { Container, Text } from "@earendil-works/pi-tui";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";

const BORDER = "\u2502 "; // │

function titleLine(label: string, detail: string, t: any, isErr?: boolean): string {
	if (isErr) {
		return t.fg("error", BORDER) + t.fg("error", t.bold(label + " ")) + t.fg("error", detail);
	}
	return t.fg("border", BORDER) + t.bold(label + " ") + detail;
}

function addBorder(text: string, t: any, isErr?: boolean): string {
	const clr = isErr ? "error" : "border";
	return text.split("\n").map((l: string) => t.fg(clr, BORDER) + l).join("\n");
}

const MAX_TITLE_LEN = 80;

function truncateDetail(detail: string): string {
	const firstLine = detail.split("\n")[0] || "";
	if (firstLine.length <= MAX_TITLE_LEN) return firstLine;
	return firstLine.slice(0, MAX_TITLE_LEN - 1) + "…";
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
				const err = c?.isError || r?.isError;
				if (o.isPartial) return new Container();
				const detail = getDetail(c?.args || {});
				if (!o.expanded) {
					const truncated = truncateDetail(detail);
					return new Text(titleLine(label, truncated, t, err), 0, 0);
				}
				const parts = r.content?.filter((c: any) => c?.type === "text").map((c: any) => c.text) || [];
				if (r.details?.diff) parts.push(r.details.diff);
				if (parts.length === 0) return new Text(titleLine(label, detail, t, err), 0, 0);
				const lines = [titleLine(label, detail, t, err), ...parts.map((p: string) => addBorder(p, t, err))].join("\n");
				return new Text(lines, 0, 0);
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
