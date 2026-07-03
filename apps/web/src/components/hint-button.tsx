import type { ReactNode } from "react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * A Button with an accessible hover/focus tooltip, replacing native `title`
 * hints. The span wrapper keeps the tooltip working even when the button is
 * disabled (disabled elements emit no pointer events).
 */
export function HintButton({
  children,
  hint,
  ...props
}: { children: ReactNode; hint?: ReactNode } & ButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex">
            <Button {...props}>{children}</Button>
          </span>
        }
      />
      {hint ? <TooltipContent>{hint}</TooltipContent> : null}
    </Tooltip>
  );
}
