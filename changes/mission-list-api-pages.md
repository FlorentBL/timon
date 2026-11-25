---
type: changed
tim: TIM-0161
---
`GET /api/missions` no longer stops at 1000 missions in silence: an out-of-range `limit` is refused, each page says whether more follow and gives the cursor to read them, and `task_id` keeps the missions of one task.
