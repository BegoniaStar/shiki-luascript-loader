-- SPDX-License-Identifier: AGPL-3.0-only
-- Original fixture for the Dice Lua compatibility layer.

msg_order = {}

local function identity(msg)
    return msg.uid .. "@" .. msg.gid
end

function compat_help(msg)
    return "compat-demo " .. identity(msg)
end

msg_order[".dlhelp"] = "compat_help"

msg_order[".dlstate"] = function(msg)
    local state = getSelfData("counter")
    state.value = (state.value or 0) + 1
    setGroupConf(msg.gid, "last", state.value)
    return "state=" .. tostring(state.value) .. ",group=" .. tostring(getGroupConf(msg.gid, "last", 0))
end

msg_order[".dlcard"] = function(msg)
    local card = getPlayerCard(msg.uid, msg.gid)
    card:set("hp", (card:get("hp", 0) or 0) + 1)
    card:lock("hp")
    return "hp=" .. tostring(card:get("hp", 0)) .. ",locked=" .. tostring(card:locked("hp"))
end

msg_reply = {
    ["dl ping"] = {
        keyword = { match = "dl ping" },
        limit = { user_id = { "42" }, prob = 90 },
        echo = function(msg)
            return "pong:" .. msg.uid
        end,
    },
}

event = {
    startup = {
        trigger = { hook = "StartUp" },
        action = { lua = function()
            return "compat-demo-started"
        end },
    },
}
