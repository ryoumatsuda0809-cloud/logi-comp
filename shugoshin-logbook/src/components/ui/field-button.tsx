import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * 現場向け大型ボタン（高さ60px以上）
 * 手袋・濡れた手でも押しやすいサイズ
 */
const fieldButtonVariants = cva(
  "inline-flex select-none items-center justify-center gap-3 whitespace-nowrap rounded-lg text-lg font-bold ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:size-6 [&_svg]:shrink-0 active:scale-[0.97] transition-transform",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        accent: "bg-accent text-accent-foreground hover:bg-accent/90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border-2 border-primary bg-background text-primary hover:bg-primary hover:text-primary-foreground",
        ghost: "hover:bg-muted text-foreground",
      },
      size: {
        default: "h-[60px] px-8 py-4 text-lg",
        lg: "h-[72px] px-10 py-5 text-xl",
        xl: "h-[84px] px-12 py-6 text-2xl",
        icon: "h-[60px] w-[60px]",
      },
      fullWidth: {
        true: "w-full",
        false: "",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
      fullWidth: true,
    },
  },
);

export interface FieldButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof fieldButtonVariants> {
  asChild?: boolean;
}

const FieldButton = React.forwardRef<HTMLButtonElement, FieldButtonProps>(
  ({ className, variant, size, fullWidth, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(fieldButtonVariants({ variant, size, fullWidth, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
FieldButton.displayName = "FieldButton";

export { FieldButton, fieldButtonVariants };
