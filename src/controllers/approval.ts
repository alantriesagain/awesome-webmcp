// This start's approval mode (src/host/approval.ts: what asks for permission), a new one each start
// over the start's kernel.
import { Controller } from "@lightstart/light/controller/class.ts";
import { ApprovalController } from "../host/approval.ts";
import kernel from "./kernel.ts";

export class ApprovalHolder extends Controller {
  /** This start's. */
  current = new ApprovalController(kernel.current);

  constructor() {
    super("approval");
  }

  override connected(): Promise<void> | null {
    this.current = new ApprovalController(kernel.current);
    return null;
  }
}

export default new ApprovalHolder();
