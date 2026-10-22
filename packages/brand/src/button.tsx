import type { ButtonHTMLAttributes, CSSProperties } from "react";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary";
};

export function Button({ variant = "primary", style, ...props }: ButtonProps) {
  const variantStyle: CSSProperties =
    variant === "secondary"
      ? {
          backgroundColor: "var(--ratel-paper)",
          color: "var(--ratel-indigo)",
          border: "1px solid var(--ratel-indigo)",
        }
      : {
          backgroundColor: "var(--ratel-indigo)",
          color: "var(--ratel-cream)",
          border: "1px solid var(--ratel-indigo)",
        };

  return (
    <button
      type="button"
      {...props}
      style={{
        fontFamily: "var(--ratel-font)",
        borderRadius: "var(--ratel-radius)",
        padding: "12px 20px",
        fontSize: 15,
        fontWeight: 600,
        cursor: "pointer",
        ...variantStyle,
        ...style,
      }}
    />
  );
}
