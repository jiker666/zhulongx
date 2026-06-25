package com.example.demo.controller;

import org.springframework.web.bind.annotation.*;
import org.springframework.beans.factory.annotation.Autowired;

/**
 * OrderController - HIGH risk demo
 * 接口接收 orderId 参数，但没有任何鉴权或资源归属校验
 * 任意登录用户可通过修改 orderId 查看其他用户的订单
 */
@RestController
@RequestMapping("/api/order")
public class OrderController {

    @Autowired
    private OrderService orderService;

    /**
     * 查询订单详情 - 无权限校验（HIGH 风险）
     */
    @GetMapping("/{orderId}")
    public OrderDetail getOrderDetail(@PathVariable Long orderId) {
        return orderService.findById(orderId);
    }

    /**
     * 修改订单状态 - 无权限校验（HIGH 风险）
     */
    @PostMapping("/update")
    public Result updateOrderStatus(@RequestParam Long orderId,
                                     @RequestParam String status) {
        orderService.updateStatus(orderId, status);
        return Result.ok();
    }

    /**
     * 删除订单 - 无权限校验（HIGH 风险）
     */
    @DeleteMapping("/{orderId}")
    public Result deleteOrder(@PathVariable Long orderId) {
        orderService.delete(orderId);
        return Result.ok();
    }
}
