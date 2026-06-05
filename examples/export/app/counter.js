'use client'
import { useState } from 'react'

export default function Counter() {
  const [n, setN] = useState(0)
  return (
    <button data-hydration-button onClick={() => setN((v) => v + 1)}>
      clicked {n} times
    </button>
  )
}
