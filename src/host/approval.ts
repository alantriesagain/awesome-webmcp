// The session's approval mode: what asks for permission. "ask" puts every request to the request
// panel, "auto" lets reads and edits in the folder through, "plan" rejects them, and "full" allows
// every one at once. `approval` is the mode, a signal, kept in state.json.
import { Controller } from "@lightstart/light/controller/class.ts";
import { signal } from "@lightstart/light/signals";
import { Kernel } from "@lightstart/kernel/kernel.ts";

/** What asks for permission: "ask", "auto", "plan" or "full". */
export type Approval = "ask" | "auto" | "plan" | "full";

/** The modes a run accepts. */
export const APPROVALS: Approval[] = ["ask", "auto", "plan", "full"];

export class ApprovalController extends Controller {
  readonly kernel: Kernel;
  /** The mode in use. */
  readonly approval = signal<Approval>("ask");

  constructor(kernel: Kernel) {
    super("approval");
    this.kernel = kernel;
  }

  /** Use mode `mode` from now on, kept for the next run; "" or why not. */
  set(mode: string): string {
    if (!APPROVALS.includes(mode as Approval)) return "no approval mode named " + mode + " (there are " + APPROVALS.join(", ") + ")";
    this.approval.value = mode as Approval;
    this.kernel.settings.setState("approval", mode);
    return "";
  }
}
