import { officeActions, useOffice } from "../../store/office";
import { ui } from "../../store/ui";
import { DeliveryPanel } from "../delivery/DeliveryPanel";
import { DrawerHeader } from "./Drawer";

/** One ticket's delivery: inspect, approve the exact merge, push, PR, checks, merge, verify. */
export function DeliveryDrawer({ deliveryKey }: { deliveryKey: string }) {
  const board = useOffice((s) => s.snap?.delivery);
  const client = useOffice((s) => s.source.delivery ?? null);
  const view = board?.byKey[deliveryKey];
  return (
    <>
      <DrawerHeader>
        <b className="text-[18px]">Deliver {deliveryKey}</b>
        <span className="truncate text-[14px] text-muted">{view?.title ?? ""}</span>
      </DrawerHeader>
      {/* Keyed by ticket: a different ticket starts with a clean form. */}
      <DeliveryPanel
        key={deliveryKey}
        deliveryKey={deliveryKey}
        board={board}
        view={view}
        client={client}
        onSignIn={() => {
          // The setup checklist's GitHub sign-in fix: re-check (a login can expire after start-up), run the
          // fix if it is already known, and open the checklist, where it shows once the re-check reports it.
          officeActions.recheckSetup();
          officeActions.runSetupFix("gh");
          ui.openSetup();
        }}
      />
    </>
  );
}
