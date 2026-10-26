import { useEffect, useRef } from 'react';
import { animate, useMotionValue, useTransform, motion } from 'motion/react';

/** Nombre qui glisse vers sa nouvelle valeur (chiffres tabulaires, pas de saut de largeur). */
export function AnimatedNumber({ value, className }: { value: number; className?: string }) {
  const mv = useMotionValue(value);
  const text = useTransform(mv, (v) => Math.round(v).toString());
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; mv.set(value); return; }
    const c = animate(mv, value, { type: 'spring', stiffness: 180, damping: 26 });
    return () => c.stop();
  }, [value, mv]);
  return <motion.span className={className}>{text}</motion.span>;
}
