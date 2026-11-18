import { useEffect, useState } from 'react';

function readWidth(): number {
  return typeof window !== 'undefined' && window.innerWidth > 0 ? window.innerWidth : 1280;
}

/** 跟随窗口宽度变化，用于在渲染时把面板宽度收敛到当前视口可容纳的范围 */
export function useViewportWidth(): number {
  const [width, setWidth] = useState(readWidth);

  useEffect(() => {
    let rafId: number | null = null;
    const handleResize = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        setWidth(readWidth());
      });
    };

    window.addEventListener('resize', handleResize);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  return width;
}
