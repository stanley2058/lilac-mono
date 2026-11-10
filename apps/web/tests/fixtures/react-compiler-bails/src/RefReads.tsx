import { useRef } from "react";

// Both components read a ref during render, so the compiler skips each for the same reason.
export function FirstRefRead() {
  const count = useRef(0);
  return <span>{count.current}</span>;
}

export const SecondRefRead = () => {
  const count = useRef(0);
  return <span>{count.current}</span>;
};
