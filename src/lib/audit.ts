import { FmsAudit } from "@/models/fms";
import type { SessionUser } from "./auth";

export async function audit(
  user: Pick<SessionUser, "employeeId" | "name" | "role"> | null,
  action: string,
  data: { entity?: string; entityId?: string; previousValue?: unknown; updatedValue?: unknown; reason?: string; ip?: string } = {},
) {
  await FmsAudit.create({
    userId: user?.employeeId ?? "SYSTEM",
    userName: user?.name ?? "System",
    userRole: user?.role ?? "SYSTEM",
    action,
    ...data,
    at: new Date(),
  });
}
