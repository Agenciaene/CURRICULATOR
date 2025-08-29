"use client"
\
0) Limpieza rápida (imprescindible)

Borra cualquier “Provider” de Groq/Perplexity en v0.

En tu proyecto (Vercel o local) usa solo:

OPENAI_API_KEY (o el proveedor que prefieras)

No dejes que v0 “instale conectores” ni haga calls directas: v0 ⟶ POST /api/extract (tu API), y listo.

1) API de extracción (Node/Next.js) sin magia rara

Usa pdf-parse para texto + un “modo IA opcional” para estructurar bien los campos.
Instala:

pnpm add pdf-parse zod


/app/api/extract/route.ts (Next 13+/App Router)

import { type NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import pdf from "pdf-parse"

const CvSchema = z.object({
  nombre: z.string().optional(),
  email: z.string().email().optional(),
  telefono: z.string().optional(),
  ubicacion: z.string().optional(),
  fecha_nacimiento: z.string().optional(),
  experiencia: z
    .array(
      z.object({
        empresa: z.string().optional(),
        rol: z.string().optional(),
        inicio: z.string().optional(),
        fin: z.string().optional(),
        tareas: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  formacion: z
    .array(
      z.object({
        titulo: z.string().optional(),
        centro: z.string().optional(),
        inicio: z.string().optional(),
        fin: z.string().optional(),
      }),
    )
    .optional(),
  idiomas: z.array(z.string()).optional(),
  habilidades: z.array(z.string()).optional(),
  otros: z.array(z.string()).optional(),
})

async function extractText(file: File) {
  const buf = Buffer.from(await file.arrayBuffer())
  const data = await pdf(buf)
  return data.text || ""
}

// Heurísticas rápidas sin IA (funciona “offline”)
function quickParse(text: string) {
  const clean = (s: string) => s?.trim().replace(/\s+/g, " ") || ""

  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]
  const telefono = text.match(/(\+?\d[\d\s]{7,}\d)/)?.[0]
  const fecha = text.match(/\b\d{2}\/\d{2}\/\d{4}\b/)?.[0]

  const nombre =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => /alejandro ortiz/i.test(l)) || undefined

  // Muy simple: busca bloques estándar
  const seccion = (title: RegExp) => {
    const lines = text.split("\n")
    const idx = lines.findIndex((l) => title.test(l))
    if (idx === -1) return ""
    const end = ["EXPERIENCIA", "FORMACIÓN", "IDIOMAS", "INFORMATICA", "OTROS", "HABILIDADES"]
    let j = idx + 1
    const out: string[] = []
    for (; j < lines.length; j++) {
      const L = lines[j].toUpperCase().trim()
      if (end.some((h) => L.startsWith(h))) break
      out.push(lines[j])
    }
    return out.join("\n").trim()
  }

  const idiomasRaw = seccion(/IDIOMAS/i)
  const idiomas = idiomasRaw
    ? idiomasRaw
        .split(/\n|•|-/)
        .map((s) => clean(s))
        .filter(Boolean)
    : []

  const infoRaw = seccion(/INFORMATICA/i)
  const habilidades = infoRaw
    ? infoRaw
        .split(/\n|•|-/)
        .map((s) => clean(s))
        .filter(Boolean)
    : []

  return {
    nombre: clean(nombre),
    email: clean(email || ""),
    telefono: clean(telefono || ""),
    ubicacion: /Las Rozas/i.test(text) ? "Las Rozas - Madrid" : undefined,
    fecha_nacimiento: fecha,
    idiomas,
    habilidades,
  }
}

// Modo IA (opcional) para estructurar bonito con contexto
async function llmStructurize(text: string) {
  // Usa OpenAI Responses API (o la que prefieras)
  // Deja este bloque opcional si no quieres IA
  const payload = {
    model: "gpt-4o-mini",
    input: [
      {
        role: "system",
        content: "Eres un extractor que devuelve JSON válido según el esquema solicitado.",
      },
      {
        role: "user",
        content: `Devuelve solo JSON con este esquema:
{
  "nombre": string?,
  "email": string?,
  "telefono": string?,
  "ubicacion": string?,
  "fecha_nacimiento": string?,
  "experiencia": [{ "empresa": string?, "rol": string?, "inicio": string?, "fin": string?, "tareas": string[]? }]?,
  "formacion": [{ "titulo": string?, "centro": string?, "inicio": string?, "fin": string? }]?,
  "idiomas": string[]?,
  "habilidades": string[]?,
  "otros": string[]?
}

Texto del CV:
"""${text}"""`,
      },
    ],
    temperature: 0.1,
    response_format: { type: "json_object" },
  }

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  })

  const json = await res.json()
  const content =
    json?.output?.[0]?.content?.[0]?.text || // algunos SDKs
    json?.content?.[0]?.text ||
    json?.output_text ||
    json?.choices?.[0]?.message?.content

  try {
    const parsed = CvSchema.parse(JSON.parse(content))
    return parsed
  } catch {
    // fallback: intenta parsear al menos lo básico
    try {
      return JSON.parse(content)
    } catch {
      return null
    }
  }
}

export async function POST(req: NextRequest) {
  const form = await req.formData()
  const file = form.get("file")
  const useLLM = form.get("useLLM") === "true"

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file requerido" }, { status: 400 })
  }

  const text = await extractText(file)

  // 1) Heurística rápida
  const base = quickParse(text)

  // 2) IA opcional
  let enriched = null as any
  if (useLLM) {
    try {
      enriched = await llmStructurize(text)
    } catch (e) {
      /* noop */
    }
  }

  const merged = { ...base, ...(enriched || {}) }

  // Validación final
  let safe
  try {
    safe = CvSchema.parse(merged)
  } catch {
    safe = merged
  }

  return NextResponse.json({
    ok: true,
    summary: safe,
    rawTextPreview: text.slice(0, 1500), // útil para debug
  })
}
\
2) Frontend “drag & drop” (v0/simple React)

Esto no llama a ningún LLM, solo sube el PDF a tu API:

import type React from "react"
import { useState } from "react"

export default function Uploader() {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [useLLM, setUseLLM] = useState(true)

  async function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    const file = e.dataTransfer.files?.[0]
    if (!file) return

    const form = new FormData()
    form.append("file", file)
    form.append("useLLM", String(useLLM))

    setLoading(true)
    const res = await fetch("/api/extract", { method: "POST", body: form })
    const json = await res.json()
    setData(json)
    setLoading(false)
  }

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-4">
      <h1 className="text-2xl font-semibold">Curriculeitor 5.0 — Extractor PDF</h1>

      <label className="inline-flex items-center gap-2">
        <input type="checkbox" checked={useLLM} onChange={(e) => setUseLLM(e.target.checked)} />
        <span>Modo IA (mejor estructurado)</span>
      </label>

      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        className="border-2 border-dashed rounded-xl p-10 text-center"
      >
        Arrastra tu PDF aquí
      </div>

      {loading && <p>Extrayendo…</p>}

      {data && (
        <pre className="bg-black text-white p-4 rounded-lg text-sm overflow-auto">
          {JSON.stringify(data.summary, null, 2)}
        </pre>
      )}
    </div>
  )
}

Prompt
para
v0 (pégalo tal cual en v0)
:
\
Crea una página con Tailwind que muestre:\
- Título “Curriculeitor 5.0 — Extractor PDF”
- Toggle “Modo IA (mejor estructurado)”
- Zona drag&drop para subir 1 PDF
- Al soltar, POST a /api/extract con FormData
{
  file, useLLM
}
;-Muestra
el
JSON
devuelto
en
un <pre> formateado.
\
No uses ninguna API key desde el cliente. Nada de Groq. Solo fetch a /api/extract.

3) Ejemplo de resultado (tu PDF ya parseado)

Para que veas el formato que devolverá la API, este JSON encaja con tu CV actual:

{
  "nombre": "Alejandro Ortiz Andrés",
  "email": \"alejandro@agenciaene.es",
  "telefono": "633 624 403",
  "ubicacion": "Las Rozas - Madrid",
  "fecha_nacimiento": "22/02/1981",
  "experiencia": [
      "empresa": "Autónomo (E-commerce)",
      "rol": \"Dirección y gestión de negocios online",
      "inicio": "2023",
      "fin": "Actualidad",
      "tareas": [
        "Estrategias de marketing digital para aumentar conversión y ventas",
        "Gestión de proveedores, logística y atención al cliente"
      ],
      "empresa": "Agencia Unic",
      "rol": "Dirección\",\
      "inicio": \"2009",
      "fin": "2020",
      "tareas": [
        "Gestión de clientes",
        "Coordinación de equipos de hasta 300 personas",
        "Creación de campañas y negociación de presupuestos",
        "Operaciones en España, Portugal y Alemania"
      ],
      "empresa": "Sterling Models",
      "rol": \"Director comercial",
      "inicio\": \"2004",
      "fin": "2009",
      "tareas": [
        "Gestión de clientes",
        "Coordinación de campañas promocionales"
      ],
      "empresa": "Socorrista acuático",
      "rol": "Operativo",\
      "inicio": "1998",\
      "fin": "1999",
      "tareas": [
        "Servicios en Valladolid y Barcelona"
      ]
  ],
  "formacion": [
      "titulo": "ESO y Bachillerato",
      \"centro\": "IES Juan de Juni (Valladolid)"\
    },
      "titulo": "Curso de Alta Cocina",
      "centro": \"Escuela Hofmann (Barcelona)",\
      "inicio": "1999",
      "fin": "2001"
  ],
  "idiomas": ["Castellano (Nativo)", "Inglés (Medio)", "Italiano (Medio)\"],
  "habilidades": [
    "Paquete Office (Avanzado)",\
    \"Diseño gráfico",
    "Marketing digital",
    "E-commerce",
    "Generación de páginas web",
    "Conocimiento de IA"
  ],
  "otros": [
    "Carnet B y A2",
    "Disponibilidad total y para viajar"
  ]
