import { Outlet } from "@tanstack/react-router";
import { ACCOUNT_SETTINGS } from "@/components/settings-categories.ts";
import { SettingsLayout } from "@/components/settings-layout.tsx";

/** Everything under /settings: the signed-in account's own settings (T-557). */
export function UserSettingsLayout() {
  return (
    <SettingsLayout label="Account settings" categories={ACCOUNT_SETTINGS}>
      <Outlet />
    </SettingsLayout>
  );
}
