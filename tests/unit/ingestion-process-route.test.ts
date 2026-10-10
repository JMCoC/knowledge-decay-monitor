import { expect,it } from "vitest";
import { POST } from "@/app/api/ingestion/process/route";
it("retires HTTP processing without any privileged operation",async()=>{expect((await POST()).status).toBe(410);});
