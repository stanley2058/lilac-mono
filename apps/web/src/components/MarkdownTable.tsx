import { createContext, useContext, useRef, type ComponentProps } from "react";
import type { ExtraProps } from "react-markdown";
import { Copy } from "lucide-react";
import { sourceAttributes } from "../markdown-source";
import { tableCsv, tableRows } from "../table-copy";
import { IconButton, attempt } from "./ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { toast } from "./ui/toast";

export const MarkdownTableContext = createContext<ReadonlyMap<string, string>>(new Map());

export function MarkdownTable({ children, node }: ComponentProps<"table"> & ExtraProps) {
  const sources = useContext(MarkdownTableContext);
  const table = useRef<HTMLTableElement>(null);
  const copy = (format: "Markdown" | "CSV") => {
    if (!table.current) return;
    const value =
      format === "Markdown"
        ? sources.get(`${node?.position?.start.offset}:${node?.position?.end.offset}`)
        : tableCsv(tableRows(table.current));
    if (value === undefined) return;
    void attempt(
      async () => {
        await navigator.clipboard.writeText(value);
        toast.add({ title: `Table copied as ${format}` });
      },
      () => toast.add({ title: "Could not copy table", type: "error" }),
    );
  };
  return (
    <div className="group/table my-3" data-ui="markdown-table">
      <div className="markdown-table">
        <table ref={table} {...sourceAttributes(node)}>
          {children}
        </table>
      </div>
      <div className="flex justify-end select-none" data-table-actions>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<IconButton label="Copy table" />}
            className="sm:opacity-0 group-hover/table:opacity-100 group-focus-within/table:opacity-100 data-popup-open:opacity-100"
          >
            <Copy />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto">
            <DropdownMenuItem onClick={() => copy("Markdown")}>Copy as Markdown</DropdownMenuItem>
            <DropdownMenuItem onClick={() => copy("CSV")}>Copy as CSV</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
