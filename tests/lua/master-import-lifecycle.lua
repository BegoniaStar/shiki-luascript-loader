-- SPDX-License-Identifier: AGPL-3.0-only
-- Original small-script fixture for lifecycle hooks and event-owned state.

msg_order = {
    [".smevents"] = function(msg)
        local state = getSelfData("lifecycle")
        return "starts=" .. (state.starts or 0)
    end,
}

event = {
    startup = {
        trigger = { hook = "StartUp" },
        action = { lua = function()
            local state = getSelfData("lifecycle")
            state.starts = (state.starts or 0) + 1
            return "watch-started"
        end },
    },
    received = {
        hook = "MessageReceived",
        action = { lua = function()
            return "received:" .. event.fromMsg
        end },
    },
    joined = {
        trigger = { hook = "GroupJoined" },
        action = { lua = function()
            return "joined:" .. event.gid
        end },
    },
}
