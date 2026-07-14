'use client'
import { useState } from 'react'

export default function Counter({ label = '' }) {
  const [n, setN] = useState(0)
  return (
    <button data-hydration-button onClick={() => setN((v) => v + 1)} style={{ marginTop: 12 }}>
      {label ? `${label}: ` : ''}clicked {n} times
    </button>
  )
}
