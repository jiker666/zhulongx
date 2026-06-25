package com.example.demo.controller;

import org.springframework.web.bind.annotation.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.access.prepost.PreAuthorize;

/**
 * UserController - LOW risk demo
 * 接口接收 userId 参数，有明确的 @PreAuthorize 权限校验和归属校验
 */
@RestController
@RequestMapping("/api/user")
public class UserController {

    @Autowired
    private UserService userService;

    @Autowired
    private PermissionService permissionService;

    /**
     * 查询用户个人信息 - 有 @PreAuthorize 注解（LOW 风险）
     */
    @GetMapping("/{userId}/profile")
    @PreAuthorize("hasPermission(#userId, 'User', 'read')")
    public UserProfile getUserProfile(@PathVariable Long userId) {
        return userService.getProfile(userId);
    }

    /**
     * 修改用户信息 - 有归属校验（LOW 风险）
     */
    @PostMapping("/{userId}/update")
    public Result updateUser(@PathVariable Long userId,
                              @RequestBody UserUpdateRequest req) {
        UserInfo currentUser = SecurityContextHelper.getCurrentUser();
        // 明确校验资源归属
        if (!checkOwner(userId, currentUser.getId())) {
            return Result.forbidden("无权操作该用户");
        }
        userService.update(userId, req);
        return Result.ok();
    }

    /**
     * 管理员查询用户列表 - 有 RBAC 校验（LOW 风险）
     */
    @GetMapping("/admin/list")
    @Secured("ROLE_ADMIN")
    public List<UserInfo> listUsers(@RequestParam(defaultValue = "1") int page) {
        return userService.listAll(page);
    }

    /**
     * 查询用户账户余额 - 有服务层鉴权（LOW 风险）
     */
    @GetMapping("/{userId}/balance")
    public Result getUserBalance(@PathVariable Long userId) {
        UserInfo currentUser = SecurityContextHelper.getCurrentUser();
        // permissionService 校验用户ID归属
        permissionService.checkAccount(userId, currentUser);
        return Result.ok(userService.getBalance(userId));
    }

    private boolean checkOwner(Long resourceUserId, Long currentUserId) {
        return resourceUserId.equals(currentUserId);
    }
}
