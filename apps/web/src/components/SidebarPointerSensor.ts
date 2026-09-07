import { PointerSensor, type PointerSensorProps } from "@dnd-kit/core";
import { getOwnerDocument, getWindow } from "@dnd-kit/utilities";

// A release outside the app can go missing. Cancel the sensor itself so its
// listeners, sortable state, and sidebar drag labels all reset together.
export class SidebarPointerSensor extends PointerSensor {
  constructor(props: PointerSensorProps) {
    const document = getOwnerDocument(props.event.target);
    const window = getWindow(props.event.target);
    const cancel = () => document.dispatchEvent(new Event("pointercancel"));
    const handleMove = (event: PointerEvent) => {
      if (event.pointerId !== (props.event as PointerEvent).pointerId) return;
      if ((event.buttons & 1) === 0) cancel();
    };
    const cleanup = () => {
      window.removeEventListener("blur", cancel);
      document.removeEventListener("pointermove", handleMove, { capture: true });
    };
    window.addEventListener("blur", cancel);
    // Run before dnd-kit's move listener, including before drag activation.
    document.addEventListener("pointermove", handleMove, { capture: true });
    super({
      ...props,
      onEnd() {
        cleanup();
        props.onEnd();
      },
      onCancel() {
        cleanup();
        props.onCancel();
      },
    });
  }
}
