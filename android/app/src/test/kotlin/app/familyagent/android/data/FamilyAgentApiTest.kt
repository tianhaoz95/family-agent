package app.familyagent.android.data

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class FamilyAgentApiTest {
    private lateinit var server: MockWebServer
    private lateinit var api: FamilyAgentApi

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        api = FamilyAgentApi(server.url("/").toString().trimEnd('/'))
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `health parses model and status`() = runBlocking {
        server.enqueue(
            MockResponse().setBody("""{"ok":true,"model":"qwen2.5:3b","ollamaBaseUrl":"http://127.0.0.1:11434"}""")
        )
        val health = api.health()
        assertTrue(health.ok)
        assertEquals("qwen2.5:3b", health.model)
    }

    @Test
    fun `listTasks parses task array`() = runBlocking {
        server.enqueue(
            MockResponse().setBody(
                """{"tasks":[{"id":"ABCD1234","title":"Buy stamps","notes":null,"dueDate":"2026-09-10","status":"open","createdAt":"2026-09-01T00:00:00.000Z","updatedAt":"2026-09-01T00:00:00.000Z"}]}"""
            )
        )
        val tasks = api.listTasks()
        assertEquals(1, tasks.size)
        assertEquals("Buy stamps", tasks[0].title)
        assertEquals("open", tasks[0].status)
    }

    @Test
    fun `createTask sends the right body`() = runBlocking {
        server.enqueue(
            MockResponse().setBody(
                """{"task":{"id":"XYZ12345","title":"Renew passport","notes":null,"dueDate":null,"status":"open","createdAt":"2026-09-01T00:00:00.000Z","updatedAt":"2026-09-01T00:00:00.000Z"}}"""
            )
        )
        val task = api.createTask("Renew passport", null)
        assertEquals("Renew passport", task.title)

        val recorded = server.takeRequest()
        assertEquals("POST", recorded.method)
        assertEquals("/tasks", recorded.path)
        assertTrue(recorded.body.readUtf8().contains("Renew passport"))
    }

    @Test
    fun `createTask forwards an optional dueTime`() = runBlocking {
        server.enqueue(
            MockResponse().setBody(
                """{"task":{"id":"XYZ12345","title":"Dentist","notes":null,"dueDate":"2026-12-01","dueTime":"09:30","status":"open","createdAt":"2026-09-01T00:00:00.000Z","updatedAt":"2026-09-01T00:00:00.000Z"}}"""
            )
        )
        val task = api.createTask("Dentist", "2026-12-01", "09:30")
        assertEquals("09:30", task.dueTime)
        assertEquals("""{"title":"Dentist","dueDate":"2026-12-01","dueTime":"09:30"}""", server.takeRequest().body.readUtf8())
    }

    @Test
    fun `rescheduleTask PATCHes the task id with an explicit dueDate and dueTime`() = runBlocking {
        server.enqueue(
            MockResponse().setBody(
                """{"task":{"id":"XYZ12345","title":"Vet visit","notes":null,"dueDate":"2026-12-01","dueTime":"11:00","status":"open","createdAt":"2026-09-01T00:00:00.000Z","updatedAt":"2026-09-01T00:00:00.000Z"}}"""
            )
        )
        val task = api.rescheduleTask("XYZ12345", "2026-12-01", "11:00")
        assertEquals("11:00", task.dueTime)

        val recorded = server.takeRequest()
        assertEquals("PATCH", recorded.method)
        assertEquals("/tasks/XYZ12345", recorded.path)
        assertEquals("""{"dueDate":"2026-12-01","dueTime":"11:00"}""", recorded.body.readUtf8())
    }

    @Test
    fun `rescheduleTask sends explicit nulls to clear date and time`() = runBlocking {
        server.enqueue(
            MockResponse().setBody(
                """{"task":{"id":"XYZ12345","title":"Vet visit","notes":null,"dueDate":null,"dueTime":null,"status":"open","createdAt":"2026-09-01T00:00:00.000Z","updatedAt":"2026-09-01T00:00:00.000Z"}}"""
            )
        )
        api.rescheduleTask("XYZ12345", null, null)
        assertEquals("""{"dueDate":null,"dueTime":null}""", server.takeRequest().body.readUtf8())
    }

    @Test
    fun `chat omits images and sessionId when not given, includes them when present`() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"reply":"hi","sessionId":"s1"}"""))
        val plainReply = api.chat("hello")
        assertEquals("s1", plainReply.sessionId)
        val plain = server.takeRequest().body.readUtf8()
        assertEquals("""{"message":"hello"}""", plain)

        server.enqueue(MockResponse().setBody("""{"reply":"a cat","sessionId":"s1"}"""))
        api.chat("what is this?", listOf("data:image/jpeg;base64,AAAA"))
        val withImg = server.takeRequest().body.readUtf8()
        assertTrue(withImg.contains(""""images":["data:image/jpeg;base64,AAAA"]"""))

        server.enqueue(MockResponse().setBody("""{"reply":"still here","sessionId":"s1"}"""))
        api.chat("continue", sessionId = "s1")
        val withSession = server.takeRequest().body.readUtf8()
        assertEquals("""{"message":"continue","sessionId":"s1"}""", withSession)
    }

    @Test
    fun `chat history sessions - list, read messages, rename, delete`() = runBlocking {
        server.enqueue(
            MockResponse().setBody(
                """{"sessions":[{"id":"s1","title":"Hi","createdAt":"t","updatedAt":"t","lastMessage":null,"messageCount":0}]}"""
            )
        )
        val sessions = api.listChatSessions()
        assertEquals(1, sessions.size)
        assertEquals("Hi", sessions[0].title)
        assertEquals("/chat/sessions", server.takeRequest().path)

        server.enqueue(
            MockResponse().setBody(
                """{"messages":[{"id":"m1","role":"user","body":"hi","createdAt":"t"}]}"""
            )
        )
        val messages = api.getChatSessionMessages("s1")
        assertEquals(1, messages.size)
        assertEquals("/chat/sessions/s1/messages", server.takeRequest().path)

        server.enqueue(
            MockResponse().setBody(
                """{"session":{"id":"s1","title":"Renamed","createdAt":"t","updatedAt":"t"}}"""
            )
        )
        val renamed = api.renameChatSession("s1", "Renamed")
        assertEquals("Renamed", renamed.title)
        val renameReq = server.takeRequest()
        assertEquals("PATCH", renameReq.method)
        assertEquals("/chat/sessions/s1", renameReq.path)
        assertEquals("""{"title":"Renamed"}""", renameReq.body.readUtf8())

        server.enqueue(MockResponse().setBody("""{"deleted":true}"""))
        api.deleteChatSession("s1")
        val deleteReq = server.takeRequest()
        assertEquals("DELETE", deleteReq.method)
        assertEquals("/chat/sessions/s1", deleteReq.path)
    }

    @Test
    fun `transcribe uploads the clip as multipart audio and parses the text`() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"text":"buy milk tomorrow"}"""))
        val res = api.transcribe(byteArrayOf(1, 2, 3, 4))
        assertEquals("buy milk tomorrow", res.text)
        val request = server.takeRequest()
        assertEquals("/transcribe", request.path)
        assertTrue(request.getHeader("Content-Type")!!.startsWith("multipart/form-data"))
        assertTrue(request.body.readUtf8().contains("""name="audio""""))
    }

    @Test
    fun `health defaults asrEnabled to false when the server omits it`() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"ok":true,"model":"m"}"""))
        assertEquals(false, api.health().asrEnabled)
    }

    @Test
    fun `non-2xx response throws ApiException with useful message`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(500).setBody("""{"error":"boom"}"""))
        try {
            api.listTasks()
            org.junit.Assert.fail("expected ApiException")
        } catch (e: ApiException) {
            assertTrue(e.message!!.contains("500"))
        }
    }

    @Test
    fun `login parses the token and user, and sends credentials`() = runBlocking {
        server.enqueue(
            MockResponse().setBody(
                """{"token":"sess-123","user":{"id":"U1","username":"dad","displayName":"Dad","role":"member"}}"""
            )
        )
        val resp = api.login("dad", "hunter22")
        assertEquals("sess-123", resp.token)
        assertEquals("Dad", resp.user.displayName)
        val recorded = server.takeRequest()
        assertEquals("/auth/login", recorded.path)
        assertTrue(recorded.body.readUtf8().contains("hunter22"))
    }

    @Test
    fun `a 401 surfaces as UnauthorizedException`() = runBlocking {
        api.authToken = "stale"
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"Not signed in."}"""))
        try {
            api.listTasks()
            org.junit.Assert.fail("expected UnauthorizedException")
        } catch (e: UnauthorizedException) {
            assertTrue(e.message!!.isNotBlank())
        }
    }

    @Test
    fun `requests carry the bearer token once set`() = runBlocking {
        api.authToken = "tok-xyz"
        server.enqueue(MockResponse().setBody("""{"tasks":[]}"""))
        api.listTasks()
        assertEquals("Bearer tok-xyz", server.takeRequest().getHeader("Authorization"))
    }

    @Test
    fun `me parses the current user`() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"user":{"id":"U1","username":"mom","displayName":"Mom","role":"admin"}}"""))
        assertEquals("admin", api.me().role)
    }

    @Test
    fun `searchDocuments encodes the query and filters, parses the results`() = runBlocking {
        server.enqueue(
            MockResponse().setBody(
                """{"results":[{"id":"DOC12345","filename":"car-insurance.pdf","category":"insurance","summary":"Auto policy","snippet":"… renewal …","createdAt":"2026-09-01T00:00:00.000Z","extractionStatus":"done"}]}"""
            )
        )
        val hits = api.searchDocuments(
            "car insurance",
            mode = "semantic",
            category = "insurance",
            dueBefore = "2026-10-01",
            limit = 12,
        )
        assertEquals(1, hits.size)
        assertEquals("Auto policy", hits[0].summary)

        val recorded = server.takeRequest()
        assertTrue(recorded.path!!.startsWith("/documents/search?"))
        assertTrue(recorded.path!!.contains("q=car+insurance") || recorded.path!!.contains("q=car%20insurance"))
        assertTrue(recorded.path!!.contains("mode=semantic"))
        assertTrue(recorded.path!!.contains("category=insurance"))
        assertTrue(recorded.path!!.contains("dueBefore=2026-10-01"))
        assertTrue(recorded.path!!.contains("limit=12"))
    }

    @Test
    fun `searchDocuments omits mode and limit when not given`() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"results":[]}"""))
        api.searchDocuments("water bill")
        val path = server.takeRequest().path!!
        assertTrue(!path.contains("mode="))
        assertTrue(!path.contains("limit="))
    }

    @Test
    fun `health parses semanticSearch, defaulting to off`() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"ok":true,"model":"m","semanticSearch":"on"}"""))
        assertEquals("on", api.health().semanticSearch)
        server.enqueue(MockResponse().setBody("""{"ok":true,"model":"m"}"""))
        assertEquals("off", api.health().semanticSearch)
    }

    @Test
    fun `health parses web, shell and compute capability flags`() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"ok":true,"model":"m","web":"on","shell":"unavailable","compute":false}"""))
        val h = api.health()
        assertEquals("on", h.web)
        assertEquals("unavailable", h.shell)
        assertEquals(false, h.compute)
        server.enqueue(MockResponse().setBody("""{"ok":true,"model":"m"}"""))
        val d = api.health()
        assertEquals("off", d.web)
        assertEquals("off", d.shell)
        assertEquals(true, d.compute)
    }

    @Test
    fun `searchTasks passes q and status`() = runBlocking {
        server.enqueue(
            MockResponse().setBody(
                """{"results":[{"id":"TSK00001","title":"Renew car registration","notes":null,"dueDate":null,"dueTime":null,"status":"open","snippet":""}]}"""
            )
        )
        val hits = api.searchTasks("registration", status = "open")
        assertEquals("Renew car registration", hits[0].title)

        val recorded = server.takeRequest()
        assertTrue(recorded.path!!.startsWith("/tasks/search?"))
        assertTrue(recorded.path!!.contains("q=registration"))
        assertTrue(recorded.path!!.contains("status=open"))
    }

    @Test
    fun `createNote sends a blank note with a position`() = runBlocking {
        server.enqueue(
            MockResponse().setBody(
                """{"note":{"id":"N0000001","scope":"shared","userId":"U1","text":"","color":"butter","x":24.0,"y":24.0,"createdAt":"2026-09-01T00:00:00.000Z","updatedAt":"2026-09-01T00:00:00.000Z"}}"""
            )
        )
        val note = api.createNote(scope = "shared", text = "", color = null, x = 24f, y = 24f)
        assertEquals(24f, note.x)

        val recorded = server.takeRequest()
        assertEquals("POST", recorded.method)
        assertEquals("/notes", recorded.path)
        val body = recorded.body.readUtf8()
        assertTrue(body.contains("\"x\":24"))
        assertTrue(body.contains("\"y\":24"))
    }

    @Test
    fun `updateNote PATCHes only the position for a drag`() = runBlocking {
        server.enqueue(
            MockResponse().setBody(
                """{"note":{"id":"N0000001","scope":"shared","userId":"U1","text":"hi","color":"butter","x":120.0,"y":80.0,"createdAt":"2026-09-01T00:00:00.000Z","updatedAt":"2026-09-01T00:00:00.000Z"}}"""
            )
        )
        api.updateNote("N0000001", x = 120f, y = 80f)

        val recorded = server.takeRequest()
        assertEquals("PATCH", recorded.method)
        assertEquals("/notes/N0000001", recorded.path)
        val body = recorded.body.readUtf8()
        assertTrue(body.contains("\"x\":120"))
        assertTrue(!body.contains("\"text\""))
    }

    @Test
    fun `listRoutines decodes the trigger union and action`() = runBlocking {
        server.enqueue(
            MockResponse().setBody(
                """{"routines":[{"id":"R1","name":"Morning briefing","enabled":true,"trigger":{"kind":"cron","expr":"0 7 * * *"},"triggerText":"every day at 7:00 AM","action":{"agent":"planner","instruction":"Summarise the day."},"deliverChannelId":null,"catchUp":"skip","nextRunAt":"2026-09-08T07:00:00.000Z","lastRunAt":null,"lastStatus":null,"createdAt":"2026-09-01T00:00:00.000Z","updatedAt":"2026-09-01T00:00:00.000Z"}]}"""
            )
        )
        val routines = api.listRoutines()
        assertEquals(1, routines.size)
        assertEquals("cron", routines[0].trigger.kind)
        assertEquals("0 7 * * *", routines[0].trigger.expr)
        assertEquals("planner", routines[0].action.agent)
        assertEquals("every day at 7:00 AM", routines[0].triggerText)
    }

    @Test
    fun `createRoutine sends only the set schedule field`() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(201).setBody(
                """{"routine":{"id":"R2","name":"Weekly review","enabled":true,"trigger":{"kind":"cron","expr":"0 18 * * 0"},"triggerText":"every Sun at 6:00 PM","action":{"agent":"task","instruction":"List open items."},"catchUp":"skip","createdAt":"2026-09-01T00:00:00.000Z","updatedAt":"2026-09-01T00:00:00.000Z"}}"""
            )
        )
        api.createRoutine(
            RoutineInput(
                name = "Weekly review",
                trigger = RoutineTriggerInput(weeklyOn = "sunday", weeklyAt = "18:00"),
                action = RoutineAction(agent = "task", instruction = "List open items."),
                deliverChannelId = null,
            )
        )
        val body = server.takeRequest().body.readUtf8()
        assertTrue(body.contains("\"weeklyOn\":\"sunday\""))
        assertTrue(body.contains("\"weeklyAt\":\"18:00\""))
        assertTrue(!body.contains("dailyAt"))
        assertTrue(body.contains("\"deliverChannelId\":null"))
    }

    @Test
    fun `setRoutineEnabled PATCHes an explicit enabled flag`() = runBlocking {
        server.enqueue(
            MockResponse().setBody(
                """{"routine":{"id":"R1","name":"x","enabled":false,"trigger":{"kind":"every","minutes":60},"action":{"agent":"planner","instruction":"x"},"catchUp":"skip","createdAt":"2026-09-01T00:00:00.000Z","updatedAt":"2026-09-01T00:00:00.000Z"}}"""
            )
        )
        api.setRoutineEnabled("R1", false)
        val recorded = server.takeRequest()
        assertEquals("PATCH", recorded.method)
        assertEquals("/routines/R1", recorded.path)
        assertEquals("""{"enabled":false}""", recorded.body.readUtf8())
    }

    @Test
    fun `documents response decodes extraction fields`() = runBlocking {
        server.enqueue(
            MockResponse().setBody(
                """{"documents":[{"id":"DOC12345","filename":"bill.txt","rawText":"hi","extracted":{"summary":"A bill","category":"bill","importantDates":["2026-10-01"]},"createdAt":"2026-09-01T00:00:00.000Z"}]}"""
            )
        )
        val docs = api.listDocuments()
        assertEquals("bill", docs[0].extracted?.category)
        assertEquals(listOf("2026-10-01"), docs[0].extracted?.importantDates)
    }
}
